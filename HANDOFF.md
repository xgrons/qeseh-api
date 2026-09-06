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
1. Not yet done: actually push to GitHub + deploy to Render (needs the user's GitHub/Render accounts — no `gh` CLI auth available in this environment). The egress-IP probe (does qeseh.net/embed hosts block Render's datacenter IPs?) can only be run once deployed.
2. Not yet done: set up the external keep-alive pinger (cron-job.org/UptimeRobot) once a live Render URL exists.
3. Not yet done: install the addon in a real Stremio client and confirm end-to-end playback (only curl-level protocol checks were run locally).

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
