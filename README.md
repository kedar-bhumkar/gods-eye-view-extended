<div align="center">

# 🌐 God's Eye View — Extended

### A fork of Bilawal Sidhu's God's Eye View, adding four data layers and a dev-sharing fix.

</div>

---

> ## 🙏 Credit — this is a fork, not an original project
>
> Everything that makes this app what it is — the photorealistic 3D globe, the cockpit, the realtime
> voice agent, the live flight / vessel / satellite / earthquake / camera layers, and the
> budget-governed proxy architecture these additions plug into — is
> **[Bilawal Sidhu](https://github.com/bilawalsidhu)'s work**
> ([@bilawalsidhu](https://www.youtube.com/@bilawalsidhu) on YouTube), released under the
> [MIT License](LICENSE).
>
> ### 👉 For what this app *is*, screenshots, quick start, API keys, voice commands, and all original documentation, go to the upstream repo:<br>**[github.com/bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view)** — and please star it there.
>
> **This README documents only what this fork changes.** Upstream is tracked as the `upstream` git
> remote, so `git fetch upstream` pulls his latest work.

---

## What this fork adds

| | Addition | Data source | Keyless? | Toggle |
|---|---|---|---|---|
| 📰 | **News layer** — a day of a country's news, pinned inside its own borders | GDELT DOC 2.0, ingested locally to SQLite | ✅ | `n` |
| 🌊 | **Wiki Pulse layer** — ambient live Wikipedia edit activity worldwide | Wikimedia EventStreams `recentchange` | ✅ | `p` |
| 🏛️ | **Indian History layer** — 49 powers from the Nandas to the British Raj | Bundled local dataset (original) | ✅ | `h` |
| 📹 | **Minnesota DOT camera pack** — Twin Cities metro traffic cameras | MnDOT 511mn.org + CARS Program | ✅ | env |
| 🗺️ | **Natural Earth country polygons** — supporting data for News placement | Natural Earth 1:10m (public domain) | ✅ | — |
| ☁️ | **Cloudflare quick-tunnel support** — share the dev server over a public URL | — | ✅ | — |

Every addition is **keyless**. None requires a new API key, account, or paid quota on top of what
upstream already asks for.

---

## Setup

Follow the [upstream quick start](https://github.com/bilawalsidhu/gods-eye-view#-quick-start) first —
it is unchanged, and this fork adds no required configuration.

```bash
npm install
npm run dev
```

The News layer is the only addition with an extra step, because it reads a database you build
locally (below). The other layers work immediately.

---

## 📰 News layer

The repo's first deliberately **non-real-time** layer: one country's news for one *day*, as pins
scattered inside that country's borders.

**Build the database first** — one HTTP call per country-day against GDELT, no API key:

```bash
node scripts/news-ingest.mjs                                      # trailing 2 days, India
node scripts/news-ingest.mjs --country=US --days=3
node scripts/news-ingest.mjs --country=IN --from=2026-06-01 --to=2026-08-26
node scripts/news-ingest.mjs --dry-run --verbose
node scripts/news-ingest.mjs --diagnose                           # why is the network failing?
```

The database lands at `.gev-cache/news.sqlite` (gitignored); override with `NEWS_DB_PATH`. The
ingester is the **only writer** — the dev server opens the file read-only and serves it at
`/api/news` and `/api/news/calendar`.

Ingestion is **idempotent by construction**: the primary key derives from country + day + canonical
URL, so overlapping windows, re-runs, and backfills upsert rather than duplicate. A missed scheduled
run heals itself on the next one, with no cursor or state file to maintain.

Three constraints shaped the layer:

- **The Cesium clock is never touched.** Rewinding it to show last Tuesday's news would send every
  aircraft on the globe backwards, because `flights.js` interpolates against `viewer.clock` and
  `satellites.js` propagates SGP4 from it. The date is a layer parameter instead.
- **Nothing polls.** `updateInterval: 0` with a slow refresh, so newly ingested rows appear without a
  reload while nothing else runs.
- **No continuous render hold.** Pins don't animate, so the idle governor stays idle; a re-query asks
  for exactly one frame.

Story impact is graded once at ingest time, from how many distinct outlets carried the same story —
the proxy and the layer only ever read the number.

## 🌊 Wiki Pulse layer

An ambient "pulse of the internet": live Wikipedia edits worldwide, relayed from Wikimedia's public
keyless `recentchange` SSE feed through `/api/wikipulse` (Node's native `fetch`, no new dependency).
Filtered to `*.wikipedia.org` edit/new events, buffered to a capped 300 rows in memory, polled by the
client every 3 s.

Deliberately **not analytical**, and the in-app card says so: a blip's globe position is
illustrative — deterministic per event id, but chosen by land-area-weighted random country pick, not
derived from the edit's language, wiki, or the editor's location. The layer answers *"is the world
editing right now"*, not *"where is this edit from"*.

**Privacy.** Wikimedia exposes unregistered editors' IP addresses in the `user` field. Those are
redacted to "Anonymous editor" **server-side, before an event is ever buffered or sent**, and again
client-side as a second independent safeguard.

Unlike the News layer there is no day or country parameter, and polls **append** rather than replace —
blips accumulate and expire on their own TTL, so the effect reads as a pulse, not a flicker.

## 🏛️ Indian History layer

49 powers that ruled in the subcontinent, from the Nandas (4th century BCE) to the British Raj
(1947), grouped into five eras: **Ancient**, **Classical**, **Early medieval**, **Late medieval**, and
**Early modern**. Each has an approximate territorial extent, key cities, and dated key events, each
linked to its English Wikipedia article.

The dataset lives in [`src/data/local_data/indian_history/`](src/data/local_data/indian_history/) and
is **original work, hand-traced for this project** — MIT licensed like the code, linking to Wikipedia
rather than copying it. See its [SOURCE.md](src/data/local_data/indian_history/SOURCE.md) for full
provenance and the era/kingdom breakdown.

## 📹 Minnesota DOT camera pack

Adds Twin Cities metro traffic cameras to the existing CCTV layer. MnDOT publishes no public API, so
the catalog is assembled by replaying the internal GraphQL endpoint 511mn.org's own site uses. Because
that query carries no coordinates, each kept camera's position is resolved from a server-generated
Google Static Maps URL already embedded in the response — **no Google Maps key is used or required**
for this.

That per-camera lookup is the one thing this pack does that the Austin / Caltrans / TfL packs don't,
so its request fan-out is bounded and capped before it runs:

| Variable | Default | Purpose |
|---|---|---|
| `CCTV_MNDOT_ENABLED` | on | Set to `0` to disable the pack entirely |
| `CCTV_MNDOT_MAX_SOURCES` | 60 (floor 8) | Caps the per-camera position lookups |

Frames come from `public.carsprogram.org`, the multi-state
[CARS Program](https://www.carsprogram.org/) platform.

## 🗺️ Natural Earth country polygons

`src/data/local_data/natural_earth/countries.json` — 233 countries, 2,945 outer rings, 2.95 MB, built
by `scripts/build-country-polygons.mjs` from Natural Earth 1:10m `ne_10m_admin_0_countries` (public
domain). Loaded lazily by the News layer, which uses it to decide which country the camera is over and
to scatter that country's pins inside its own border.

1:10m rather than 1:50m, and that choice was **measured, not assumed**: against 14 real city
coordinates, the 50m dataset placed only 7 inside their own country — New York, Miami, Kochi, Hong
Kong, and San Francisco all landed in the sea.

## ☁️ Cloudflare quick-tunnel support

Vite only answers to hostnames in `server.allowedHosts`, so a [Cloudflare quick
tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
pointed at the dev server returned `Blocked request. This host is not allowed.` `vite.config.js` now
allows the `.trycloudflare.com` subdomain wildcard:

```bash
npm run dev                                    # localhost:4173 via PORT in .env
cloudflared tunnel --url http://localhost:4173
```

A wildcard rather than one hostname, because quick-tunnel subdomains are regenerated on every run —
otherwise the config needs editing after each restart. The localhost-only default and Vite's
DNS-rebinding protection are both preserved: hosts outside the allowlist are still refused, so this is
**not** `allowedHosts: true`.

> If the page loads but hot reload doesn't reconnect, the HMR websocket is hitting Cloudflare's 443
> while Vite advertises the dev port. Add `hmr: { protocol: 'wss', clientPort: 443 }` to the same
> `server` block.

---

## Where the changes live

```
scripts/news-ingest.mjs              GDELT -> SQLite ingester (idempotent, no API key)
scripts/build-country-polygons.mjs   Natural Earth -> countries.json
src/data/news*.js                    News layer, policy, placement, presentation
src/data/wikiPulse*.js               Wiki Pulse layer, placement, presentation
src/data/indianHistory*.js           Indian History layer + presentation
src/data/local_data/indian_history/  Bundled kingdoms dataset (original, MIT)
vite.config.js                       /api/news, /api/news/calendar, /api/wikipulse proxies;
                                     MnDOT camera source; allowedHosts for quick tunnels
src/data/layerState.js               Registers the n / p / h layer toggles
```

Each new module ships unit tests alongside it (`*.test.mjs`); run everything with `npm test`.

---

## License & credits

**[MIT](LICENSE)** — original copyright **Bilawal Sidhu**, preserved unmodified. The MIT grant covers
**source code only**, and the upstream LICENSE carve-outs apply in full to this fork:

- **Bundled datasets are not MIT.** Notably `telegeography_submarine_cables/` is **CC BY-NC-SA 3.0 —
  NonCommercial**. If you use this project commercially, remove those files or license them from
  TeleGeography. Datacenter/dam extracts are ODbL 1.0 (attribution + share-alike).
- **3D models** under `public/models/` keep their individual licenses — see that folder's README.
- **Capture GIFs** in `docs/media/` were created and are owned by Bilawal Sidhu and are not
  MIT-licensed standalone assets — see [media provenance](docs/media/README.md).
- **Live feeds** are fetched under each provider's terms; some restrict commercial use and require
  your own credentials.

Additions in this fork cite their own sources: **GDELT Project** (citation + link required),
**Wikimedia EventStreams** (CC0), **Natural Earth** (public domain), **Minnesota DOT — 511mn.org**.
Full per-source license and attribution summary: **[DATA_SOURCES.md](DATA_SOURCES.md)**.

Upstream's boundary applies here too: this project models **events, assets, infrastructure, and
systems** — not people. No named-person search, face recognition, or individual tracking.

<div align="center">

**Original project → [github.com/bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view)**

</div>
