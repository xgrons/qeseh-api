# HANDOFF — qeseh.net API + Stremio addon (MOP)
updated: 2026-09-06

## Task
- Host the qeseh.net API for free (Render) and expose its catalog as a Stremio addon, served from the same process.

## Done
- Split the former monolithic `server.js` into `qeseh.js` (scrapers + cache), `unpack.js` (pure-JS eval-packer decoder), `addon.js` (Stremio protocol), `server.js` (routing only).
- Replaced the `eval()`-based embed unpacker with a pure-JS reimplementation of the Dean Edwards `p,a,c,k,e,d` packer algorithm (`unpack.js`) — no `eval`/`vm` on untrusted remote HTML anymore. Verified byte-identical output against the old eval path on 3 live HLS embeds (Arab HD, estream, Red HD) via `Junk/verify_unpack.js` (script since removed after verification passed).
  - Found and fixed a latent quote-escaping bug in the ported `skipQuote` helper (an escaped quote matching the delimiter, e.g. `\'` inside a `'...'` string, was wrongly treated as the string's end) — this bug also existed in the original `server.js`/`Junk/unpack3.js` skipQuote, just never manifested visibly there.
- Hardened `qeseh.js` for public/free hosting: bounded (500-entry) + self-sweeping cache with stale-while-revalidate (serves an expired entry immediately, refreshes in background); `/discover/` page crawl now capped at 4 concurrent fetches via a `mapLimit` helper instead of unbounded `Promise.all`; discover TTL raised 60s → 15min (SWR keeps it fresh without hammering the site); catalog warm-up call on boot.
- Added `NotFoundError` (carries `httpStatus: 404`) — both a real upstream 404 (`get()`) and a parsed-but-missing series/episode now surface as HTTP 404 instead of 502, so Stremio shows "not found" instead of treating it as a retryable failure.
- `server.js` now reads `process.env.PORT` (falls back to 8787) and binds `0.0.0.0`.
- Added `addon.js`: hand-rolled (no SDK) Stremio manifest + catalog (`qeseh-series` with search/skip, `qeseh-latest`) + meta (episodes as `videos[]`, synthetic stable `released` dates since the site has none) + stream (resolves HLS/dailymotion servers concurrently, bounded to 4 at a time with a 20s overall budget; embed/direct servers passed through as `externalUrl`).
- Added `package.json` (zero deps, `"start": "node server.js"`), `.node-version` (22), `render.yaml` (Render blueprint, free plan), `.gitignore` (excludes `Junk/`).
- Updated `README.md`: file layout, `$PORT`, hardening notes, Render hosting steps + free-tier caveats (15min spin-down, external pinger), Stremio install/catalogs/ID scheme/limits.
- Verified locally end-to-end: all original API routes (`/`, `/series`, `/series/:slug`, episode detail, stream auto-pick, `?server=dailymotion`, `?raw=1`) produce identical shapes to before the refactor; all new Stremio routes (`/manifest.json`, both catalogs incl. search-via-extra and `skip` pagination, `/meta/...`, `/stream/...`) return valid, populated JSON; 404s confirmed on both a real upstream 404 and a route mismatch.

## Now
1. Done: pushed to GitHub (`xgrons/qeseh-api`, public, `main` branch) via a user-supplied classic PAT (repo scope), then deployed to Render via API using a user-supplied Render API key. Live at https://qeseh-api.onrender.com (service `srv-daepqnnqj5pc73aeuibg`). Egress-IP probe passed: qeseh.net, the HLS embed hosts, and dailymotion all respond normally from Render's IP — no blocking observed.
2. Done: cron-job.org keep-alive job created via API (job `8395487`, user-supplied API key), GET `/` every 10 minutes, UTC, enabled.
3. Done: real Stremio-client testing surfaced two bugs, both fixed and verified locally (see below) — redeploy to Render is the remaining step before re-testing in the app.

All three GitHub/Render/cron-job.org credentials used above were supplied by the user in-chat for this one-time setup and were not stored anywhere (not in the repo, not in memory). The user was advised to revoke/regenerate them after setup if they want.

## Bugs found via real Stremio playback (fixed)
- **Red HD / estream didn't play.** Root cause: those CDNs (cdn-centaurus, artrk's "arbtrk" node) bind the signed HLS URL to the IP that first requested it — i.e. this server's Render IP — so a client on any other network gets a 403 on the exact same URL that resolves fine server-side. Confirmed by curling the resolved URL from outside Render (403) vs. through the existing `raw=1` proxy (200). Not IP-locked: Arab HD (artrk's "trkarb" node), dailymotion.
  - Fix: added a generic media proxy, `GET /px?u=<url>&r=<referer>` (`qeseh.proxyMedia` in `qeseh.js`, route in `server.js`). It re-fetches the target from this server's IP; if the response is an m3u8 playlist it rewrites every segment/sub-playlist reference (and any `URI="..."` in tags) to also go through `/px`, so the whole playback chain — playlist and every segment — re-originates from here. Binary segments stream through via `Readable.fromWeb(...).pipe(res)`, no buffering.
  - `addon.js`'s `stream()` now takes a third `base` param (the request's own origin, from `server.js`'s existing `baseUrl(req)`) and wraps every resolved HLS/dailymotion `url` as `<base>/px?u=...&r=...` before handing it to Stremio. HLS types get `r=https://qesen.net/` (same Referer the server already used to resolve them); dailymotion gets no referer (confirmed unnecessary). The plain `/series/.../stream` REST API is untouched — still returns the raw CDN URL as documented, since that's a deliberate, separate contract.
- **Dailymotion resolution inconsistent (sometimes 480p instead of 1080p).** Root cause, in two parts:
  1. First suspected (and fixed, but not sufficient alone): the stale-while-revalidate cache was serving an *expired* `dm:meta:<code>` entry (the dailymotion "auto" master URL) immediately on expiry. Added an `swr` option to `cached()` (default `true`); `dm:meta:` now passes `{ swr: false }` so an expired entry always blocks on a fresh fetch instead of serving a stale one.
  2. Actual root cause: dailymotion's own "auto" master endpoint is independently flaky — confirmed empirically that fetching the *exact same* signed master URL back-to-back sometimes returns the full 4-variant set (up to 1920x1080) and sometimes a thinner one, unrelated to our caching. A 15x back-to-back fetch of one master URL showed the documented 403/200 alternation but every 200 response was the full body — yet a separate live-server run still reproduced a thin pick, so the flakiness is real and upstream, not fully explained by our code.
  - Fix: `resolveStream`'s dailymotion branch now retries up to 3 times (fresh `dailymotionStream()` call each time) and keeps the best (highest-resolution) result across attempts, stopping early once it sees 1080p. Verified: 8 calls spanning 56+ seconds (crossing the cache TTL) all returned 1920x1080, vs. visibly flaky before the fix.
- Debug scripts used for diagnosis (`Junk/debug_dm_*.js`, `Junk/verify_unpack.js`) were all removed after use — nothing scratch-only was committed.

## Files
- `server.js` — HTTP routing only, both plain API and Stremio routes, `$PORT`.
- `qeseh.js` — scraper module: fetch/parse/cache/resolve, `NotFoundError`, `mapLimit`.
- `unpack.js` — pure-JS `p,a,c,k,e,d` unpacker (`unpackEval`, `unpackWithArgs`, `parseCallArgs`).
- `addon.js` — Stremio manifest/catalog/meta/stream handlers.
- `package.json` / `.node-version` / `render.yaml` / `.gitignore` — deploy scaffolding.
- `Junk/` — scratch probes, local-only (gitignored). `new-core.js` and `dm_*` files documented the server map / dailymotion flow that's now in `qeseh.js`.

## Decisions
- Zero dependencies kept throughout, including the Stremio addon (hand-rolled protocol, no `stremio-addon-sdk`).
- Render free tier chosen over HF Spaces (Docker Spaces need a paid plan) and Cloudflare Workers (forbids `eval`, 10ms free CPU cap — irrelevant now that `eval` is gone, but the always-on process model still favors Render for the in-memory cache).
- Addon served from the same process as the API (no second deployment, no extra HTTP hop, one cold start instead of two).
- Episode IDs use a synthetic single-season scheme (`qeseh:<slug>:1:<n>`) since the site has no season structure and no IMDB ids.
- `videos[].released` is a required Stremio field with no real source data; using a deterministic synthetic date per episode number keeps ordering stable and avoids anything showing as "upcoming".
