// qeseh.net scraper module — zero deps, Node 18+.
// list series → series detail → episode detail (servers) → resolve stream (m3u8)
const { unpackEval } = require('./unpack.js');

const SITE = 'https://qeseh.net';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// A "not found" error carries an httpStatus so the HTTP layer can return
// 404 instead of the generic 502 used for scrape/upstream failures.
class NotFoundError extends Error {
  constructor(msg) { super(msg); this.httpStatus = 404; }
}

// ---------- helpers ----------
async function get(url, headers = {}) {
  const h = { 'User-Agent': UA, ...headers };
  let err;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { headers: h, redirect: 'follow', signal: AbortSignal.timeout(15000) });
      if (r.ok) return await r.text();
      if (r.status === 404) throw new NotFoundError('HTTP 404 for ' + url); // definitive, don't retry
      err = new Error('HTTP ' + r.status + ' for ' + url);
    } catch (e) {
      if (e instanceof NotFoundError) throw e;
      err = e;
    }
  }
  throw err;
}

// ---------- bounded, self-sweeping, stale-while-revalidate cache ----------
// A public host running this unattended needs the cache to (a) never grow
// without bound and (b) serve fast on catalog hits even when an entry just
// expired — refresh happens in the background instead of blocking the caller.
const CACHE_MAX = 500;
const cache = new Map(); // key -> { exp, v, refreshing }

function cacheSet(key, v, ttl) {
  if (!cache.has(key) && cache.size >= CACHE_MAX) {
    const oldestKey = cache.keys().next().value; // Map preserves insertion order
    cache.delete(oldestKey);
  }
  cache.delete(key); // re-insert at the end so it's "newest" for the LRU-ish eviction above
  cache.set(key, { exp: Date.now() + ttl, v });
}

async function cached(key, ttl, fn) {
  const c = cache.get(key);
  if (c) {
    if (c.exp > Date.now()) return c.v;
    // Stale: serve immediately, refresh in the background (deduped).
    if (!c.refreshing) {
      c.refreshing = true;
      fn().then(v => cacheSet(key, v, ttl)).catch(() => { c.refreshing = false; });
    }
    return c.v;
  }
  const v = await fn();
  cacheSet(key, v, ttl);
  return v;
}

setInterval(() => {
  const now = Date.now();
  for (const [key, c] of cache) {
    if (c.exp <= now && !c.refreshing) cache.delete(key);
  }
}, 60e3).unref();

// Bounded-concurrency map, used to avoid firing an unbounded burst of
// simultaneous outbound requests (e.g. every /discover/ page at once).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function clean(s) { return (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
function stripName(t) { return (t || '').replace(/^مسلسل\s*/, '').replace(/\s*-\s*قصة عشق$/, '').trim(); }

function extractM3u8(js) {
  const urls = js.match(/https?:\/\/[^\s"'<>\\]+?\.m3u8[^\s"'<>\\]*/g) || [];
  return urls.find(u => u.includes('master.m3u8')) || urls[0] || null;
}

// ---------- server map (from Junk/new-core.js; keys normalized lowercase) ----------
const SERVERS = {
  'arab hd':    { hls: true, embed: id => `https://arabhd.onl/embed-${id}.html` },
  'estream':    { hls: true, embed: id => `https://arabveturk.com/embed-${id}.html` },
  'box':        { hls: true, embed: id => `https://youdboox.com/embed-${id}.html` },
  'now':        { hls: true, embed: id => `https://extreamnow.org/embed-${id}.html` },
  'red hd':     { hls: true, embed: id => `https://iplayerhls.com/e/${id}` },
  'pro hd':     { hls: true, embed: id => `https://embedo.co/e/${id}` },
  'dailymotion': { dm: true, embed: id => `https://www.dailymotion.com/video/${id}` },
  'youtube':    { direct: id => `https://www.youtube.com/watch?v=${id}` },
  'youtube_in': { embed: id => `https://www.youtube.com/embed/${id}` },
  'ok':         { embed: id => `https://ok.ru/videoembed/${id}` },
  'express':    { direct: id => id },
};
const norm = s => (s || '').toLowerCase().trim();
function serverInfo(name, id, payload) {
  const s = SERVERS[norm(name)];
  if (!s) return { name, id };
  return { name, id, type: s.hls ? 'hls' : (s.direct ? 'direct' : (s.dm ? 'dailymotion' : 'embed')), url: (s.direct || s.embed)(id, payload) };
}

// auto-pick order when ?server= is omitted (HLS first, known-good quality)
const SERVER_PRIORITY = ['red hd', 'arab hd', 'estream', 'box', 'now', 'pro hd', 'dailymotion', 'ok', 'youtube', 'youtube_in', 'express'];
function pickServer(available) {
  for (const pref of SERVER_PRIORITY) {
    const hit = available.find(s => norm(s.name) === pref && s.url);
    if (hit) return hit;
  }
  return available.find(s => s.url) || available[0] || null;
}

// parse an HLS master playlist, return the highest-resolution variant (relative URLs resolved against baseUrl)
function pickBestVariant(masterBody, baseUrl) {
  const lines = masterBody.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l.startsWith('#EXT-X-STREAM-INF')) continue;
    const rm = l.match(/RESOLUTION=(\d+)x(\d+)/);
    const bm = l.match(/BANDWIDTH=(\d+)/);
    let url = null;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j].trim();
      if (!t) continue;
      if (t.startsWith('#')) break;
      url = t; break;
    }
    if (!url) continue;
    try { url = new URL(url, baseUrl).href; } catch {}
    variants.push({ url, w: rm ? +rm[1] : 0, h: rm ? +rm[2] : 0, bw: bm ? +bm[1] : 0 });
  }
  if (!variants.length) return null;
  variants.sort((a, b) => (b.w * b.h - a.w * a.h) || (b.bw - a.bw));
  return variants[0];
}

// ---------- dailymotion ----------
// cdndirector toggles 403/200 per request: each response re-arms the signed token for the
// NEXT request, but only if it arrives within ~50ms. So retry back-to-back, no sleeps.
const DM_HEADERS = { 'User-Agent': UA, 'X-Request-Origin': 'https://geo.dailymotion.com' };
async function dmFetch(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { headers: DM_HEADERS, signal: AbortSignal.timeout(15000) });
    if (r.status === 200) return r;
    last = r;
    await r.text().catch(() => {}); // drain body so the keep-alive connection reuses cleanly
  }
  throw new Error('HTTP ' + last.status + ' after ' + tries + ' tries');
}
async function dailymotionMaster(code) {
  const r = await fetch('https://www.dailymotion.com/player/metadata/video/' + code, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('dailymotion metadata HTTP ' + r.status);
  const m = await r.json();
  const master = m.qualities && m.qualities.auto && m.qualities.auto[0] && m.qualities.auto[0].url;
  if (!master) throw new Error('no auto quality in dailymotion metadata');
  return master;
}
async function dailymotionStream(code) {
  let master = await cached('dm:meta:' + code, 60e3, () => dailymotionMaster(code));
  try {
    return { master, body: await (await dmFetch(master)).text() };
  } catch {
    master = await dailymotionMaster(code); // signature likely expired; refresh once
    return { master, body: await (await dmFetch(master)).text() };
  }
}

// ---------- scrapers ----------
async function listSeries() {
  const html = await cached('discover:1', 15 * 60e3, () => get(SITE + '/discover/'));
  const maxPage = Math.max(1, +((html.match(/<a href='https:\/\/qeseh\.net\/discover\/page\/(\d+)\/'>&raquo;<\/a>/) || [])[1] || 1));
  const pageIndexes = Array.from({ length: maxPage }, (_, i) => i + 1);
  const pages = await mapLimit(pageIndexes, 4, (n) =>
    n === 1 ? html : cached('discover:' + n, 15 * 60e3, () => get(SITE + '/discover/page/' + n + '/')));
  const seen = new Map();
  for (const page of pages) {
    for (const m of page.matchAll(/<a href="https:\/\/qeseh\.net\/yeni-show\/([^/]+)\/" title="([^"]+)">[\s\S]*?background-image:url\(([^)]+)\)/g)) {
      if (!seen.has(m[1])) seen.set(m[1], { slug: m[1], name: stripName(m[2]), poster: m[3], url: SITE + '/yeni-show/' + m[1] + '/' });
    }
  }
  return [...seen.values()];
}

async function seriesDetail(slug) {
  const html = await cached('series:' + slug, 300e3, () => get(SITE + '/yeni-show/' + slug + '/'));
  if (!/<h1>/.test(html)) throw new NotFoundError('series not found: ' + slug);
  const name = stripName(clean((html.match(/<h1>([^<]+)<\/h1>/) || [])[1]));
  const poster = (html.match(/background-image:url\(([^)]+)\)/) || [])[1];
  const story = clean((html.match(/<div class="story">([\s\S]*?)<\/div>/) || [])[1]);
  const tax = (html.match(/<div class="tax">([\s\S]*?)<\/div>/) || [])[1] || '';
  const cast = [...tax.matchAll(/title="([^"]+)"/g)].map(m => m[1]);
  const episodes = [...html.matchAll(/<a href="https:\/\/qeseh\.net\/clarus\/([^/]+?)-episode-(\d+)\/" title="([^"]*)">[\s\S]*?background-image:url\(([^)]+)\)/g)]
    .map(m => ({ n: +m[2], slug: m[1], title: m[3], poster: m[4], url: SITE + '/clarus/' + m[1] + '-episode-' + m[2] + '/' }));
  return { slug, name, poster, description: story, cast, status: /class="noResult/.test(html) ? 'coming_soon' : 'available', episodes };
}

async function search(q) {
  const html = await cached('search:' + q, 120e3, () => get(SITE + '/?s=' + encodeURIComponent(q)));
  const out = [];
  for (const m of html.matchAll(/<a href="(https:\/\/qeseh\.net\/(?:yeni-show|clarus)\/[^/]+\/)" title="([^"]*)">[\s\S]*?background-image:url\(([^)]+)\)/g)) {
    const em = m[1].match(/clarus\/([^/]+?)-episode-(\d+)\/$/);
    out.push(em
      ? { type: 'episode', slug: em[1], n: +em[2], title: stripName(m[2]), poster: m[3], url: m[1] }
      : { type: 'series', slug: m[1].split('/yeni-show/')[1].replace(/\/$/, ''), title: stripName(m[2]), poster: m[3], url: m[1] });
  }
  return out;
}

async function latest(page = 1) {
  const url = page > 1 ? SITE + '/son-bolumler/page/' + page + '/' : SITE + '/son-bolumler/';
  const html = await cached('latest:' + page, 120e3, () => get(url));
  const maxPage = Math.max(1, +((html.match(/<a href='https:\/\/qeseh\.net\/son-bolumler\/page\/(\d+)\/'>&raquo;<\/a>/) || [])[1] || 1));
  const box = html.slice(html.indexOf('id="load-post-episodes"'), html.indexOf('<footer>'));
  const episodes = [...box.matchAll(/<a href="https:\/\/qeseh\.net\/clarus\/([^/]+?)-episode-(\d+)\/" title="([^"]*)">[\s\S]*?background-image:url\(([^)]+)\)/g)]
    .map(m => ({ n: +m[2], slug: m[1], title: stripName(m[3]), poster: m[4], url: SITE + '/clarus/' + m[1] + '-episode-' + m[2] + '/' }));
  return { page, max_page: maxPage, episodes };
}

async function episodeDetail(slug, n) {
  // episode URL uses its own slug, which can differ from the series slug (e.g. series "foo-mreku" -> episodes "foo-episode-N")
  const series = await seriesDetail(slug);
  const ep = series.episodes.find(e => e.n === +n);
  if (!ep) throw new NotFoundError('episode not found: ' + slug + ' #' + n);
  const html = await cached('ep:' + ep.slug + ':' + n, 300e3, () => get(ep.url));
  const title = clean((html.match(/<h1>([^<]+)<\/h1>/) || [])[1]);
  const poster = (html.match(/background-image:\s*url\('([^']+)'\)/) || html.match(/background-image:url\(([^)]+)\)/) || [])[1];
  const postID = (html.match(/vo_postID\s*=\s*"(\d+)"/) || [])[1];
  const wm = html.match(/https:\/\/qesen\.net\/watch\?post=([A-Za-z0-9+/=]+)/);
  if (!wm) throw new Error('watch link not found');
  const payload = JSON.parse(Buffer.from(wm[1], 'base64').toString('utf8'));
  return {
    slug, n, title, poster, postID,
    url: ep.url,
    servers: (payload.servers || []).map(s => serverInfo(s.name, s.id, payload)),
  };
}

async function resolveStream(slug, n, serverName) {
  const ep = await episodeDetail(slug, n);
  let srv;
  if (serverName) {
    srv = ep.servers.find(s => norm(s.name) === norm(serverName));
    if (!srv) return { error: 'server not found', available: ep.servers.map(s => s.name) };
  } else {
    srv = pickServer(ep.servers);
    if (!srv) return { error: 'no servers available' };
  }
  if (!srv.url) return { error: 'unknown server type', server: srv.name };
  if (srv.type === 'dailymotion') {
    const { master, body } = await dailymotionStream(srv.id);
    const best = pickBestVariant(body, master);
    const out = { server: srv.name, type: 'hls', dm: true, master, embed: srv.url };
    if (best) { out.url = best.url; out.resolution = best.w + 'x' + best.h; }
    else out.url = master;
    return out;
  }
  if (srv.type !== 'hls') return { server: srv.name, type: srv.type, url: srv.url };
  const embedHtml = await cached('embed:' + srv.url, 300e3, () => get(srv.url, { Referer: 'https://qesen.net/' }));
  const m3u8 = extractM3u8(unpackEval(embedHtml));
  if (!m3u8) return { error: 'm3u8 not found in embed', server: srv.name, embed: srv.url };
  const e = (m3u8.match(/[?&]e=(\d+)/) || [])[1];
  const out = { server: srv.name, type: 'hls', master: m3u8, expires_in: e ? +e : null, embed: srv.url };
  // fetch the master playlist and hand back the highest-resolution variant directly,
  // so the client can play `url` without parsing the master (fixes players that pick the lowest variant)
  try {
    const masterBody = await cached('master:' + m3u8, 120e3, () => get(m3u8, { Referer: 'https://qesen.net/' }));
    const best = pickBestVariant(masterBody, m3u8);
    if (best) { out.url = best.url; out.resolution = best.w + 'x' + best.h; }
    else out.url = m3u8;
  } catch {
    out.url = m3u8; // master fetch failed; fall back to the master playlist itself
  }
  return out;
}

module.exports = {
  SITE, UA,
  get, cached, cache,
  SERVERS, SERVER_PRIORITY, norm, pickServer, serverInfo,
  listSeries, seriesDetail, search, latest, episodeDetail, resolveStream,
  dmFetch,
  NotFoundError,
};
