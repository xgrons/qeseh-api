# qeseh.net — Unofficial API + Stremio addon

Zero-dependency Node.js scraper API for [qeseh.net](https://qeseh.net) (قصة عشق, Turkish series/episodes, Arabic subtitles), with a built-in Stremio addon served from the same process.

## Live deployment

- API: https://qeseh-api.onrender.com
- Stremio manifest: https://qeseh-api.onrender.com/manifest.json
- Stremio install link: `stremio://qeseh-api.onrender.com/manifest.json`

Hosted free on Render (`srv-daepqnnqj5pc73aeuibg`), kept awake by a cron-job.org job (`8395487`) pinging `/` every 10 minutes.

## Files

| File | Role |
|---|---|
| `server.js` | HTTP routing only (both the plain API and the Stremio routes) |
| `qeseh.js` | Scraper module: site fetch/parse, cache, stream resolution |
| `unpack.js` | Pure-JS decoder for eval-packed embed pages (no `eval`) |
| `addon.js` | Stremio protocol: manifest, catalog, meta, stream |

## Run

```
node server.js   # Node 18+ (uses global fetch)
```

Listens on `$PORT` if set, else `8787`. No env vars or secrets are required.

## Endpoints

| Endpoint | Description |
|---|---|
| `GET /` | API info |
| `GET /series` | All series (slug, name, poster, url) |
| `GET /series/:slug` | Series detail: name, poster, description, cast, `status` (`available` / `coming_soon`), episodes[] |
| `GET /series/:slug/episodes/:n` | Episode detail: title, poster, `servers[]` (name, id, type, url) |
| `GET /series/:slug/episodes/:n/stream` | Resolve the best stream. `server` is optional (auto-picked, HLS-first). For HLS: `url` = **highest-resolution variant** (playable directly, no master parsing), `master` = full master playlist, `resolution` = e.g. `1920x1080`, `expires_in`. embed/direct → embed URL |
| `GET /series/:slug/episodes/:n/stream?server=NAME` | Same, but force a specific server (e.g. `Red%20HD`, `Arab%20HD`) |
| `GET /series/:slug/episodes/:n/stream?raw=1` | Proxy the resolved m3u8 (HLS only) |
| `GET /search?q=QUERY` | Search series + episodes (Arabic or Turkish) |
| `GET /latest[?page=N]` | Latest episodes, 30 per page, returns `max_page` |
| `GET /manifest.json` | Stremio addon manifest |
| `GET /catalog/series/qeseh-series[/search=Q\|skip=N].json` | Stremio catalog: all series, optional search/pagination |
| `GET /catalog/series/qeseh-latest[/skip=N].json` | Stremio catalog: latest episodes, one row per series |
| `GET /meta/series/qeseh:SLUG.json` | Stremio meta: series detail + episode list as `videos[]` |
| `GET /stream/series/qeseh:SLUG:1:N.json` | Stremio streams for episode N (all servers resolved in parallel) |
| `GET /px?u=URL&r=REFERER` | Media proxy: re-fetches an HLS playlist/segment from this server (see Notes) |

## Server types

| name | type | notes |
|---|---|---|
| Arab HD | hls | `arabhd.onl/embed-<id>.html` |
| estream | hls | `arabveturk.com/embed-<id>.html` |
| box | hls | `youdboox.com/embed-<id>.html` |
| now | hls | `extreamnow.org/embed-<id>.html` |
| Red HD | hls | `iplayerhls.com/e/<id>` |
| Pro HD | hls | `embedo.co/e/<id>` |
| dailymotion | hls | resolved via dailymotion metadata → cdndirector master (see note) |
| ok / youtube / youtube_in / express | embed / direct | embed URL returned as-is |

HLS embeds are eval-packed (`eval(function(p,a,c,k,e,d)`); the server unpacks them to extract the signed `master.m3u8` (TTL in `expires_in`, typically 12h).

Dailymotion: the video code is the server `id` in the episode payload (the payload's `codeDaily` is a shared placeholder). The server fetches `player/metadata/video/{code}` → signed cdndirector master, then picks the highest-res variant. cdndirector alternates 403/200 per request (the token re-arms only if the next request lands within ~50ms), so the master is fetched with a zero-delay retry loop plus `X-Request-Origin: https://geo.dailymotion.com`. Output shape is identical to the HLS path (`type: "hls"`, `dm: true`).

## Examples

```bash
curl 'http://127.0.0.1:8787/series' | head
curl 'http://127.0.0.1:8787/series/mercan-kosk'
curl 'http://127.0.0.1:8787/series/mercan-kosk/episodes/1'
curl 'http://127.0.0.1:8787/series/mercan-kosk/episodes/1/stream'            # best stream, server auto-picked
curl 'http://127.0.0.1:8787/series/mercan-kosk/episodes/1/stream?server=Arab%20HD'
curl 'http://127.0.0.1:8787/series/mercan-kosk/episodes/1/stream?server=dailymotion'
curl 'http://127.0.0.1:8787/search?q=مرجان'
curl 'http://127.0.0.1:8787/latest'
```

Example dailymotion response:

```json
{
"server": "dailymotion",
"type": "hls",
"dm": true,
"master": "https://cdndirector.dailymotion.com/cdn/manifest/video/xb4boze.m3u8?sec=WrHJZV4AKCTxsUjVDNMcazWKwidD4RPmjxs7oujOoKl4YE_UgoCTdY-f9k4p8FtkJcxpZCWSYnQolH0DlsQe9Q&dmTs=894310&dmV1st=B5FE65051CC79680D7FAD0B71F4B5F2B",
"embed": "https://www.dailymotion.com/video/k6ShNm8xVwrOIrJvhSa",
"url": "https://vod3.cf.dmcdn.net/sec2(uQxe6S-Z-CG8hCYz3voY4ABHKUh9TZ-5of92ax0fw14fM9cPp0oa9f-VN01Gmvi1j-ZyCLLv8565l-xy2vfkWuxwwEfaqQqRIIFFWevo2w6g7UFrirkQqGUpCKxe6eHDlCJV_rJrJeu8Wq9vYtw5c1R3yfb9UGLPsSNN6p8cS0TNE8nhXu7w9PQcahDrEx4YophdEnEAggTQJ6j44wVK7Q)/video/fmp4/672391994/h264_aac_fhd/2/manifest.m3u8#cell=cf3",
"resolution": "1920x1080"
}
```

## Notes

- Responses are JSON, UTF-8, `Access-Control-Allow-Origin: *`.
- In-memory TTL cache (2 min–15 min per page type), stale-while-revalidate: an expired entry is served immediately while it refreshes in the background, so a warm cache never blocks a request. Capped at 500 entries with a background sweep, so it can't grow without bound on a long-running host.
- The `/discover/` catalog crawl fetches at most 4 pages concurrently (not all at once), to avoid bursting the upstream site and to survive on a small (512 MB) instance.
- Errors: `400` missing param, `404` unknown route or series/episode not found, `502` upstream/scrape failure.
- The m3u8 needs a `Referer` header only for the embed pages; the resolved CDN m3u8 plays standalone.
- The eval-packed embed pages (`eval(function(p,a,c,k,e,d)...)`) are decoded by a pure-JS implementation of the packer algorithm in `unpack.js` — no `eval()` or `vm` is used anywhere, since these pages come from third-party sites not under our control.
- Some CDNs (observed: Red HD/cdn-centaurus, estream/artrk) bind their signed HLS URLs to the IP that first requested them, so handing the raw `url` to a client on a different network returns 403. The Stremio addon works around this by routing every playable stream through `/px?u=<url>&r=<referer>`, which re-fetches the playlist (rewriting every segment reference to also go through `/px`) and streams segments from this server's own IP. This means Stremio playback traffic flows through this Render instance, not directly from the CDN — fine for personal use, but worth knowing if you're watching from multiple devices at once on a free instance's bandwidth. The plain `/series/.../stream` API still returns the raw direct CDN URL as documented; use `?raw=1` there if you need a guaranteed-working proxy instead.
- Dailymotion's "auto" master occasionally comes back with fewer quality renditions than it actually has (an upstream flakiness, confirmed by re-fetching the same signed URL repeatedly). `resolveStream` retries up to 3 times and keeps the best result, which reliably recovers the full (usually 1080p) variant set.

## Hosting for free (Render)

This runs well on [Render](https://render.com)'s free web service tier: a real always-on Node process (so the in-memory cache actually helps), free HTTPS, no credit card.

1. Push this repo to GitHub.
2. On Render: **New → Blueprint** (uses `render.yaml` in this repo) or **New → Web Service**, connect the repo, plan **Free**. Build command empty, start command `node server.js`.
3. Render sets `PORT` itself; `server.js` reads it automatically.
4. **Free-tier caveat:** Render spins a free web service down after 15 minutes with no inbound traffic, and the next request pays a ~30–60s cold start. To keep it warm, add a free external pinger (e.g. [cron-job.org](https://cron-job.org) or UptimeRobot) hitting `GET /` every 10 minutes — well under the 750 free instance-hours/month. This is a workaround, not something Render guarantees; a paid instance is the only way to avoid the spin-down entirely.
5. On boot the server also crawls `/series` once in the background, so the catalog is warm before the first real hit lands.

If qeseh.net or the embed hosts ever block Render's datacenter IPs entirely (403 / Cloudflare challenge on routes that work locally), that's a different, harder problem than the per-CDN IP-locking `/px` solves — there's no general-purpose outbound proxy built in for that case.

## Stremio addon

The same deployment serves a Stremio addon — no separate hosting needed.

- **Install:** in Stremio, paste `https://<your-app>.onrender.com/manifest.json` (or `stremio://<your-app>.onrender.com/manifest.json`) into the addon search bar. The running server's `GET /` response also includes ready-made `stremio.manifest` / `stremio.install` links for whatever host it's running on.
- **Catalogs:** "Qeseh — All Series" (all series, with Stremio's search wired to `/search`) and "Qeseh — Latest Episodes" (from `/latest`).
- **IDs:** series are `qeseh:<slug>`, episodes are `qeseh:<slug>:1:<n>` (the site has no seasons, so everything is season 1).
- **Streams:** for each episode, every HLS/dailymotion server is resolved concurrently (best quality first); other server types (e.g. `ok`) are offered as an external link instead of a playable stream.
- **Known limits:** no IMDB/TMDB ids (titles are exactly as published on the site, in Arabic/Turkish), no season structure, and resolved stream URLs expire (~12h for HLS) so Stremio re-resolves on every play rather than caching a stream long-term.
