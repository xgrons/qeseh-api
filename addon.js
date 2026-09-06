// Stremio addon protocol handlers — catalog/meta/stream, built directly on
// the qeseh.js scraper module. Hand-rolled (no stremio-addon-sdk dependency),
// consistent with the rest of this zero-dependency project.
const qeseh = require('./qeseh.js');

const MANIFEST = {
  id: 'org.qeseh.stremio',
  version: '1.0.0',
  name: 'قصة عشق (Qeseh)',
  description: 'Turkish series with Arabic subtitles, scraped from qeseh.net. No IMDB metadata — titles are as published on the site.',
  logo: 'https://qeseh.net/favicon.ico',
  resources: ['catalog', 'meta', 'stream'],
  types: ['series'],
  idPrefixes: ['qeseh:'],
  catalogs: [
    {
      type: 'series',
      id: 'qeseh-series',
      name: 'Qeseh — All Series',
      extra: [{ name: 'search' }, { name: 'skip' }],
    },
    {
      type: 'series',
      id: 'qeseh-latest',
      name: 'Qeseh — Latest Episodes',
      extra: [{ name: 'skip' }],
    },
  ],
};

const PAGE_SIZE = 100;
const EPISODES_PER_LATEST_PAGE = 30;

function seriesMeta(s) {
  return { id: 'qeseh:' + s.slug, type: 'series', name: s.name, poster: s.poster, posterShape: 'poster' };
}

// released is a required field on Stremio Video objects. The site gives no
// air dates, so synthesize a stable, strictly-increasing past date per
// episode number — this fixes ordering and keeps nothing flagged as upcoming.
function releasedFor(n) {
  return new Date(Date.UTC(2000, 0, 1) + n * 86400e3).toISOString();
}

async function catalogSeries(extra) {
  const search = extra.search;
  const skip = Math.max(0, +extra.skip || 0);
  let list;
  if (search) {
    const results = await qeseh.search(search);
    const seen = new Set();
    list = [];
    for (const r of results) {
      if (seen.has(r.slug)) continue;
      seen.add(r.slug);
      list.push({ slug: r.slug, name: r.title, poster: r.poster });
    }
  } else {
    list = await qeseh.listSeries();
  }
  return { metas: list.slice(skip, skip + PAGE_SIZE).map(seriesMeta) };
}

async function catalogLatest(extra) {
  const skip = Math.max(0, +extra.skip || 0);
  const page = Math.floor(skip / EPISODES_PER_LATEST_PAGE) + 1;
  const { episodes } = await qeseh.latest(page);
  const seen = new Set();
  const metas = [];
  for (const ep of episodes) {
    if (seen.has(ep.slug)) continue;
    seen.add(ep.slug);
    metas.push({
      id: 'qeseh:' + ep.slug,
      type: 'series',
      name: ep.title,
      poster: ep.poster,
      posterShape: 'poster',
      description: 'Latest: episode ' + ep.n,
    });
  }
  return { metas };
}

async function catalog(type, id, extra) {
  if (type !== 'series') return { metas: [] };
  if (id === 'qeseh-series') return catalogSeries(extra);
  if (id === 'qeseh-latest') return catalogLatest(extra);
  return { metas: [] };
}

function parseQeshId(id) {
  // qeseh:<slug>[:season:episode]
  const m = /^qeseh:([^:]+)(?::(\d+):(\d+))?$/.exec(id);
  if (!m) return null;
  return { slug: m[1], season: m[2] ? +m[2] : null, episode: m[3] ? +m[3] : null };
}

async function meta(type, id) {
  const parsed = parseQeshId(id);
  if (!parsed || type !== 'series') throw new qeseh.NotFoundError('not a qeseh series id: ' + id);
  const s = await qeseh.seriesDetail(parsed.slug);
  const videos = s.status === 'coming_soon' ? [] : s.episodes.map(e => ({
    id: 'qeseh:' + s.slug + ':1:' + e.n,
    title: e.title || (s.name + ' — Episode ' + e.n),
    season: 1,
    episode: e.n,
    thumbnail: e.poster,
    released: releasedFor(e.n),
  }));
  return {
    meta: {
      id: 'qeseh:' + s.slug,
      type: 'series',
      name: s.name,
      poster: s.poster,
      background: s.poster,
      description: s.description,
      cast: s.cast,
      posterShape: 'poster',
      videos,
    },
  };
}

// Resolve playable streams for one episode. Runs the HLS/dailymotion servers
// concurrently (bounded) so one slow/dead server doesn't block the rest, and
// caps total wait so Stremio's own UI timeout isn't hit on a cold cache.
const STREAM_CONCURRENCY = 4;
const STREAM_BUDGET_MS = 20000;

// Signed HLS URLs from these embed hosts are fetched via the same Referer
// our own server used to resolve them; dailymotion's CDN needs no Referer
// (only a UA, which the proxy always sends).
const EMBED_REFERER = 'https://qesen.net/';

function proxied(base, rawUrl, referer) {
  return base + '/px?u=' + encodeURIComponent(rawUrl) + (referer ? '&r=' + encodeURIComponent(referer) : '');
}

async function stream(type, id, base) {
  const parsed = parseQeshId(id);
  if (!parsed || type !== 'series' || parsed.episode == null) throw new qeseh.NotFoundError('not a qeseh episode id: ' + id);
  const ep = await qeseh.episodeDetail(parsed.slug, parsed.episode);

  const ordered = qeseh.SERVER_PRIORITY
    .map(pref => ep.servers.find(s => qeseh.norm(s.name) === pref))
    .filter(Boolean);

  const resolvable = ordered.filter(s => s.type === 'hls' || s.type === 'dailymotion');
  const passthrough = ordered.filter(s => s.type === 'embed' || s.type === 'direct');

  const budget = new Promise(resolve => setTimeout(() => resolve('timeout'), STREAM_BUDGET_MS));
  const resolved = [];
  let idx = 0;
  async function worker() {
    while (idx < resolvable.length) {
      const srv = resolvable[idx++];
      try {
        const r = await qeseh.resolveStream(parsed.slug, parsed.episode, srv.name);
        if (r && r.url && !r.error) resolved.push({ srv, r });
      } catch { /* skip a server that fails to resolve */ }
    }
  }
  await Promise.race([
    Promise.all(Array.from({ length: Math.min(STREAM_CONCURRENCY, resolvable.length) }, worker)),
    budget,
  ]);

  // Keep SERVER_PRIORITY order among whatever resolved in time.
  resolved.sort((a, b) => resolvable.indexOf(a.srv) - resolvable.indexOf(b.srv));

  // Some of these CDNs bind the signed URL to the IP that resolved it (this
  // server's), so handing the raw URL to a client on a different IP 403s.
  // Routing through our own /px proxy re-originates every request from
  // this server's IP, so playback works regardless of the client's network.
  const streams = resolved.map(({ srv, r }) => ({
    name: 'Qeseh',
    title: srv.name + (r.resolution ? ' • ' + r.resolution : ''),
    url: proxied(base, r.url, r.dm ? '' : EMBED_REFERER),
    behaviorHints: { notWebReady: true, bingeGroup: 'qeseh-' + qeseh.norm(srv.name) },
  }));

  for (const srv of passthrough) {
    streams.push({ name: 'Qeseh', title: srv.name + ' (external)', externalUrl: srv.url });
  }

  return { streams };
}

module.exports = { MANIFEST, catalog, meta, stream, parseQeshId };
