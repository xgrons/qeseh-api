// qeseh-api — HTTP routing only. Scraping lives in qeseh.js, the Stremio
// protocol lives in addon.js. Zero deps, Node 18+ (global fetch).
const http = require('node:http');
const qeseh = require('./qeseh.js');
const addon = require('./addon.js');

// ---------- http ----------
function send(res, code, body, headers = {}) {
  const buf = Buffer.from(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Content-Length': buf.length, ...headers });
  res.end(buf);
}
const json = (res, obj, code = 200) => send(res, code, JSON.stringify(obj, null, 2));

function statusFor(err) {
  return err && err.httpStatus ? err.httpStatus : 502;
}

function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:8787';
  return proto + '://' + host;
}

// Stremio's protocol appends an optional "extra" path segment before the
// trailing ".json", shaped like a query string (e.g. "search=foo&skip=100"),
// URL-component-encoded per key/value. Parse it the same way regardless of
// where in the path it shows up.
function parseExtra(seg) {
  const out = {};
  if (!seg) return out;
  for (const pair of seg.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
  }
  return out;
}

http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const p = u.pathname;
    let m;

    if (p === '/') {
      const base = baseUrl(req);
      return json(res, {
        name: 'qeseh-api',
        site: qeseh.SITE,
        endpoints: {
          'GET /series': 'list all series',
          'GET /series/:slug': 'series detail + episode list',
          'GET /series/:slug/episodes/:n': 'episode detail + servers',
          'GET /series/:slug/episodes/:n/stream[?server=NAME][&raw=1]': 'resolve stream; url = highest-res variant, master = full playlist; server auto-picked if omitted; raw=1 proxies the m3u8',
          'GET /search?q=QUERY': 'search series + episodes',
          'GET /latest[?page=N]': 'latest episodes (paginated)',
        },
        stremio: {
          manifest: base + '/manifest.json',
          install: 'stremio://' + base.replace(/^https?:\/\//, '') + '/manifest.json',
        },
      });
    }

    // ---------- qeseh API routes ----------
    if (p === '/series') return json(res, await qeseh.listSeries());
    if ((m = p.match(/^\/series\/([^/]+)$/))) return json(res, await qeseh.seriesDetail(decodeURIComponent(m[1])));
    if ((m = p.match(/^\/series\/([^/]+)\/episodes\/(\d+)$/))) {
      return json(res, await qeseh.episodeDetail(decodeURIComponent(m[1]), m[2]));
    }
    if ((m = p.match(/^\/series\/([^/]+)\/episodes\/(\d+)\/stream$/))) {
      // tolerate copy-paste from docs, e.g. "Red HD[" from "server=NAME[&raw=1]"
      const server = (u.searchParams.get('server') || '').replace(/[[\]]/g, '').trim();
      const r = await qeseh.resolveStream(decodeURIComponent(m[1]), m[2], server);
      if (u.searchParams.get('raw') === '1' && r.type === 'hls') {
        const body = r.dm ? await (await qeseh.dmFetch(r.url)).text() : await qeseh.get(r.url, { Referer: 'https://qesen.net/' });
        return send(res, 200, body, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      }
      return json(res, r);
    }
    if (p === '/search') {
      const q = u.searchParams.get('q') || '';
      if (!q) return json(res, { error: 'missing q param' }, 400);
      return json(res, await qeseh.search(decodeURIComponent(q)));
    }
    if (p === '/latest') {
      const page = Math.max(1, +u.searchParams.get('page') || 1);
      return json(res, await qeseh.latest(page));
    }

    // ---------- Stremio addon routes ----------
    if (p === '/manifest.json') return json(res, addon.MANIFEST);
    if ((m = p.match(/^\/catalog\/([^/]+)\/([^/]+?)(?:\/([^/]+))?\.json$/))) {
      const extra = parseExtra(m[3]);
      return json(res, await addon.catalog(decodeURIComponent(m[1]), decodeURIComponent(m[2]), extra));
    }
    if ((m = p.match(/^\/meta\/([^/]+)\/([^/]+)\.json$/))) {
      return json(res, await addon.meta(decodeURIComponent(m[1]), decodeURIComponent(m[2])));
    }
    if ((m = p.match(/^\/stream\/([^/]+)\/([^/]+)\.json$/))) {
      return json(res, await addon.stream(decodeURIComponent(m[1]), decodeURIComponent(m[2]), baseUrl(req)));
    }

    // Media proxy: some CDNs bind their signed HLS URLs to the IP that
    // resolved them (this server's), so a client playing the raw URL
    // directly gets a 403. Routing playback through here re-originates
    // every request (playlist + segments) from this server's IP.
    if (p === '/px') {
      const target = u.searchParams.get('u');
      if (!target) return json(res, { error: 'missing u param' }, 400);
      return qeseh.proxyMedia(target, u.searchParams.get('r') || '', req, res);
    }

    json(res, { error: 'not found' }, 404);
  } catch (e) {
    json(res, { error: e.message }, statusFor(e));
  }
}).listen(process.env.PORT || 8787, '0.0.0.0', () => {
  console.log('qeseh-api on http://0.0.0.0:' + (process.env.PORT || 8787));
  // Warm the catalog cache on boot so the first real request (and the
  // keep-alive pinger) don't pay for a cold /discover/ crawl.
  qeseh.listSeries().catch(() => {});
});
