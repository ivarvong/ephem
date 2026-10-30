# Telemetry and profiling

How to see what prod ephem is doing: traces, per-version CPU numbers, and CPU/heap profiles. Every command here has been
run against prod. **Keep this file current:** when a command, flag, span, attribute or gotcha changes, update it in the
same change, and add the date to "Last verified".

Last verified: 2026-10-30 (version 4e7c34ee; crossing span + MCP probe b49a8a02; MCP section 68c58ae5; Caching section c72a360c; cold-split, LOAD=track and isolate warmth fbdb337e; geoid bands + bundle A/B 5c337183 / 164e1cd7 / 61305294).

## The loop

instrument → gate green → commit → deploy (`scripts/deploy.sh main "…"`: gate in a clean worktree, deploy, smoke, MCP probe) → drive uncached load →
**measure by exact version** (`cpu-by-version.py`, `trace.py`, `profile.sh`) → fix the biggest measured bucket → repeat.
Every number you report carries its version id (and trace id or profile file). Log runs in
`~/code/lab_notebook/ephem-deploy-2026-10-28.md`.

## Tools (`scripts/obs/`)

| Tool | What it gives you |
| --- | --- |
| `python3 scripts/obs/cpu-by-version.py [--minutes 30] [--path /v1/alignment] [--version 80f5b087] [--entrypoint Api] [--from ISO --to ISO]` | CPU and wall p50/p90/p99 and the CPU sum per (version, entrypoint, path, status) from invocation events; entrypoint is `default` (front door), `Api`, `BlockStore` or `MetarFeed`. The A/B tool. `--path` is sent as a server-side filter (the events view caps at 1000 rows per query); `--from/--to` pin an absolute window. Wall includes waitUntil: see "Request logs (Basin)". |
| `python3 scripts/obs/basin.py status\|failures\|provision\|sql <name>\|crosscheck\|types` | Basin request logs: resources, `basin_send_failed` counts, sink/pipeline provisioning, canned Basin SQL, Basin-vs-o11y counts. See "Request logs (Basin)". |
| `python3 scripts/obs/trace.py <traceId>` or `--latest /v1/day` | One request: invocation CPU/wall, the Effect span tree with work counts, and the runtime's own spans (fetch, jsRpc, R2). The front door and the Api invocation it called are two traces sharing one cf-ray (the Api's ends in its colo, e.g. `-IAD`). |
| `scripts/obs/profile.sh <full-version-uuid> [cpu\|heap] [ms]` | Drives uncached load, captures a prod profile of that exact version, symbolizes it, prints the top. Files land in `profiles/` (gitignored). |
| `scripts/obs/load.sh [rounds] [base]` | Uncached load: per round, one 24 h Moon alignment and one `/v1/day`, each with a fresh window or place so the Api cache misses. `LOAD=weather` instead sends 4 `/v1/weather` requests per round (random land-weighted lat/lons, n = 1–3), ~16 req/s. `LOAD=track`: 2 homepage-shaped `/v1/track` per round (72 h from a UTC midnight, 20-min grid, 217 samples) at fresh lat/lons, ~8 req/s; also works under `profile.sh`. |
| `python3 scripts/obs/cold-split.py --from ISO --to ISO [--route track] [--json out.json]` | Api CPU by isolate warmth: each Api invocation of the route joined to its handler span's `ephem.isolate_computes` (1 = the isolate's first computation), p50/p90/p99 and CPU sum per bucket, and the runtime-GET → Effect-GET gap (isolate start-up before the router). Versions before the attribute fall back to "L1 empty" as the cold proxy. |
| `python3 scripts/obs/metar-cache.py [--minutes 30] [--version 80f5b087] [--slice 2]` | METAR feed cache: per (version, tier) request count, share, wall and CPU p50/p99, parses, data age; upstream calls (MetarFeed's `{"evt":"metar.upstream"}`) by status, conditional, and per minute. Joins each `{"evt":"metar"}` log line to its invocation on `$metadata.requestId`. |
| `python3 scripts/obs/cache-probe.py [base] --mode repeat\|unique\|burst [--keys 10] [--repeats 5] [--burst 50] [--routes day,…]` | Client-side cross-check of Workers Caching: per request `x-ephem-cache` (the Api's cf-cache-status relayed by the front door), client and server-timing latency; p50/p99 by (route, status). `burst` fires N concurrent identical cold requests (collapsing test); count Api invocations for that key with a `starts_with` filter on `$workers.event.request.url = https://api.internal/<path>?<sorted query>`. |
| `node --experimental-strip-types scripts/obs/mcp-probe.ts [base]` | Full MCP client session against `/mcp` (legacy handshake + modern 2026-07-28 flow + error cases); every tool call (8 tools, incl. `crossing` and `sight_line`; the alignment call uses heightRef/targetHeightRef=msl, aim=litCentroid, include=sun,phase) is checked equal to its REST endpoint (the POST tool `alignment_search` against its REST POST), plus the REST 400 UnknownParameter and a null `apparentAltitude` case. Pass/fail table with latency and cf-ray. Run after every deploy. |
| `python3 scripts/obs/trace.py --jsonrpc-id <id>` | The trace of one MCP message (the probe's ids are `<run>-<step>`). |
| `python3 scripts/obs/symbolize.py in.pb [out.pb]` | Replaces minified function names in a prod pprof with names read from the source (see "Source maps"). |

All of them shell out to the `cf` CLI (OAuth as ivar). Reading profiles needs `go` (`go tool pprof`).

## Traces

Workers traces are on (`observability.traces: { enabled: true, headSamplingRate: 1 }` in `cloudflare.config.ts`), so every
request is traced. `src/trace.ts` maps the Effect `Tracer` onto workerd's `tracing` API, so every `Effect.withSpan` and
`annotateCurrentSpan` lands in Workers traces.

**Workers' tracing API can't nest spans under Effect fibers,** so every Effect span is emitted as a direct child of the
request span. The real tree is rebuilt from `effect.span_id`, `effect.parent_id` and `effect.parent`; `trace.py` does
this.

**Spans you will see** (from a `/v1/alignment` miss):

| Span | Source | Key attributes |
| --- | --- | --- |
| `GET` (Effect, front door) | HttpRouter | `http.route`, `ephem.api_cache` (the Api's cf-cache-status: HIT / MISS / EXPIRED / UPDATING / STALE / BYPASS; `LOCAL` when computed in the front door; `LOOPBACK_ERROR`) |
| `api.fetch` | src/responses.ts | `ephem.api_key` (path + sorted query), `ephem.api_cache`, `http.status_code` — real ms: the whole loopback incl. tier lookups |
| `alignment` / `day` / `position` / `track` / `crossing` / `sightline` | handlers (Api invocation) | `blocks`, `reads`, `l1`, `blocks_<status>`, `fetchedBytes`, `ephem.isolate_computes` (computations this isolate has run, this one included: 1 = fresh isolate) |
| `compute.<endpoint>` | handlers | `ephem.block_reads`, `ephem.instants`, `ephem.iterations`, `ephem.track_points`, `ephem.events`, `ephem.crossings` (compute.crossing), `ephem.obstacles` (compute.sightline; `ephem.instants` = samples) |
| `geoid.load` | src/geoid.ts (position, day, crossing, track: every route with an observer; alignment: one per band its standing points can reach, target lat ± maxDistanceKm, plus observerLat) | `geoid.bands` (1, or 2 at a band edge), `geoid.l1`, `geoid.<status>` per fetched band (`geoid.hit`, `geoid.miss`, …), `geoid.fetchedBytes`, `ephem.geoid_cache` (`L1`, or `HIT:1`). Runs concurrently with `blocks.load`. See "Geoid bands (EGM96 from R2)" |
| `blocks.load` | src/blocks.ts | `blocks.count`, `ephem.blocks_cache` (`L1`, or `HIT:2,MISS:1`: BlockStore loopback statuses), `cache.l1`, `cache.blocks_hit` / `cache.blocks_miss` / …, `cache.fetchedBytes`; `cache.originReads/originBytes` only for in-process reads (tests, dev) |
| `GET` (runtime) | workerd | `cpu_time_ms`, `wall_time_ms`, geo |
| `fetch` / `jsRpcCall` (runtime) | workerd | a loopback fetch; `jsRpcCall method=send` is the Basin pipeline send (~1 s, after the response) |
| `weather` → `metar.feed`, `metar.nearest` | src/weather.ts | `metar.tier` (MetarFeed loopback cf-cache-status, lower-cased; `stale-on-error`), `ephem.feed_cache` (same, upper-cased), `metar.data_age_s`, `metar.bytes` (gz bytes read; 0 when the version was already parsed), `metar.parsed`, `metar.version` (upstream ETag), `metar.stations`, `metar.error`; `metar.nearest`, `metar.nearest_km`, `metar.n` |
| `magnetic` | src/weather.ts | — (WMM2025, pure) |

**Frozen clock.** Timers don't advance during pure compute on Workers, so `compute.*` spans always read 0 ms. Only
I/O-bound spans (`api.fetch`, `blocks.load`, `metar.feed`) have real durations. For compute, read the work counts on the
span and the invocation's `cpuTimeMs`; for where the CPU goes, profile.

**Ingest lag:** a trace is queryable about 10–30 s after the request.

**Raw queries** if the scripts don't cover it (`--body` JSON; `--parameters-filters` flags are rejected):

```sh
NOW=$(($(date +%s)*1000))
cf o11y telemetry query --body '{"queryId":"adhoc","timeframe":{"from":'$((NOW-600000))',"to":'$NOW'},
  "view":"events","limit":200,"parameters":{"filters":[
  {"key":"$metadata.service","operation":"eq","type":"string","value":"ephem"},
  {"key":"$metadata.traceId","operation":"eq","type":"string","value":"<traceId>"}]}}'
```

Views: `events` (invocations: `$metadata.type = cf-worker-event`; spans: `type = span`), `traces` (one row per trace),
`calculations`. Useful keys: `$workers.cpuTimeMs`, `$workers.wallTimeMs`, `$workers.scriptVersion.id`,
`$workers.event.request.url`, `$workers.event.response.status`, `$metadata.traceId`. The `events` view returns at most
1000 rows per query.

## Caching (Workers Caching; never the Cache API)

No `caches.default` anywhere (`grep -rn "caches\." packages/worker/src` is empty). Caching is Workers Caching in front of
the entrypoints whose `exports` entry enables it (`cloudflare.config.ts`), driven only by the Cache-Control they return.

```
eyeball ─▶ default (cache OFF: always runs → every request has its trace, Basin row, request.cf; `/` and `/mcp` live here)
             ├─ GET /v1/day, /v1/alignment, /v1/track, /v1/sightline, /v1/crossing, /v1/position|magnetic with time
             │     ─▶ loopback.ts api: Api.fetch(path + sorted query, { cf: { cacheKey: "/v<CACHE_VERSION>" + path + query } })
             │        Api (cache ON) ─▶ blocks: loopback.ts block  GET /block/v<N>/<sha16>/<i>  (BlockStore, cache ON) ─▶ R2 range read
             │                      ├▶ geoid:  loopback.ts geoid  GET /geoid/v<N>/<sha16>/<band> (BlockStore, cache ON) ─▶ R2 range read (ephem-geoid)
             │                      └▶ weather: loopback.ts feed  GET /feed/v<N>/metars.cache.csv.gz (MetarFeed, cache ON) ─▶ aviationweather.gov
             └─ live (position / magnetic without time) and /v1/weather: computed in the front door (blocks via BlockStore, feed via MetarFeed)
```

A HIT never runs the cached entrypoint, so it leaves no Api invocation, trace or log; the front door always runs and
records the Api's `cf-cache-status` as `ephem.api_cache` (span) / `api_cache` (Basin row) and relays it to clients as
`x-ephem-cache`. Hit rates are therefore server-side observable; `cache-probe.py` is the client-side cross-check.

**Cache-Control** (src/responses.ts, tests in test/responses.test.ts):

| Route | Api (what Workers Caching stores) | Outward (browsers) | Why |
| --- | --- | --- | --- |
| `/v1/day`, `/v1/alignment`, `/v1/track`, `/v1/sightline`, `/v1/crossing` (window or date), `/v1/position` + `time`, `/v1/magnetic` + `time` | `public, max-age=31536000, immutable` | same | pure function of the query; CACHE_VERSION is in the key and is bumped when answers change |
| `/v1/weather` | computed in the front door (feed via MetarFeed loopback); `API_WEATHER` = `public, max-age=0, stale-while-revalidate=300, stale-if-error=3600` only if called directly | `private, max-age=30` | keys almost never repeat, and forwarding paid the tier-colo round trip (see "Why forwarded weather is slower") |
| `/v1/position`, `/v1/magnetic` without `time` | not forwarded (`API_LIVE` = `public, max-age=0` if called directly) | `no-store` / `public, max-age=3600` | max-age=0 forwarding measured +35 ms server p50 with no sequential hits (below) |
| any non-200 from the Api, or no Cache-Control | `no-store` | `no-store` | errors are never cached (a router 404 was heuristically cached for 3 min on fd72f501) |
| `/` | — (never forwarded) | `private, no-store` | the sky at request.cf's location; the cache key ignores request.cf |
| `/docs` (plain HTML), `/docs/interactive` (Scalar), `/llms.txt`, `/openapi.json` | — | `public, max-age=300` | cheap; served by the front door (src/docs.ts) |
| `/mcp` | — (POST; tool calls go through the same forward) | — | |
| BlockStore `/block/v<N>/<sha16>/<i>` | `public, max-age=31536000, immutable` | — | blocks never change for a file hash (in the path) |
| BlockStore `/geoid/v<N>/<sha16>/<band>` | `public, max-age=31536000, immutable` | — | a band never changes for the geoid object's hash (in the path); sha-checked before it is served |
| MetarFeed `/feed/v<N>/metars.cache.csv.gz` | `public, max-age=60, stale-while-revalidate=600, stale-if-error=86400` | — | upstream regenerates ~1/min; ≤ 10 min stale while one revalidation runs; a day of upstream outage still answers (STALE) |

**Keys and versions.** Workers Caching keys by entrypoint + path + query (+ ctx.props, + version unless
`crossVersionCache`); the host is not in the key, nor are other request headers (the forwarded `x-ephem-ray` is not: two
rays, same query → MISS then HIT, c72a360c). `crossVersionCache` is Worker-wide (it "applies to every entrypoint whose
cache is on"). It is on (ivar, 2026-10-29: "Turn on cross version, but we keep our own version tag in code if we need to
bump"), so cached answers, blocks and the feed survive deploys, and the only partition is **`CACHE_VERSION`** in
`src/cache-version.ts`, carried by every loopback key: Api `cf.cacheKey` = `/v<N>` + path + sorted query, BlockStore
`/block/v<N>/<sha16>/<i>` and `/geoid/v<N>/<sha16>/<band>`, MetarFeed `/feed/v<N>/…`. Two guardrails:

- `src/loopback.ts` is the only code that fetches our entrypoints; `test/loopback.test.ts` scans `src/` and fails on any
  other read of a binding off `ctx.exports`.
- `test/golden.test.ts` hashes the bodies (minus provenance / diagnostics) of a fixed set of deterministic requests (day,
  position + time, alignment, track, crossing, magnetic + time) into `test/golden/answers.json` with the CACHE_VERSION they were
  recorded at. Answers changed and CACHE_VERSION did not → "answers changed: bump CACHE_VERSION and re-record". After a
  bump: `npm run golden:record` (one command) and commit both. Two agents changing answers at once: whoever commits second
  rebases, bumps and re-records.

A bump makes every Api / block / feed entry a MISS once (blocks and feed refill from R2 / upstream). A format-only change
to blocks or the feed needs a bump too (the golden test does not see it).

**MetarFeed.** Every weather request in the Api fetches the feed through the loopback; `cf-cache-status` is the tier.
Revalidations arrive as conditional requests and are passed upstream (If-None-Match / If-Modified-Since), so an
unchanged feed is a 304 → `REVALIDATED`. Collapsing and SWR are the cache's: there is no hand-written single-flight or
background refresh any more. The parsed table (lazy parser: id + coordinates indexed, stations decoded on demand) stays in
isolate memory keyed by ETag / Last-Modified: a version is parsed once per isolate, and a request whose loopback answers
with the version already parsed reads no body. If the loopback fails or answers non-200, the isolate's last table answers
as `stale-on-error`. Logs: `{"evt":"metar",tier,dataAgeS,bytes,parsed,version,error,n,nearest,km}` per weather request
(Api invocation) and `{"evt":"metar.upstream",status,bytes,ms,conditional,version}` per upstream call (MetarFeed
invocation). Old → new fields: `tier` l1 → hit, l1-stale/l2-stale → updating, origin → miss/expired, origin-304 →
revalidated, stale-on-error → stale (cache) or stale-on-error (isolate); `upstreamStatus` and `refresh` moved to
`metar.upstream`; `upstreamBytes` → `bytes`.

### Measured (2026-10-29, client EWR; run ids in brackets)

| | Cache API (80f5b087) | Workers Caching v1 (c72a360c) |
| --- | --- | --- |
| repeated deterministic key (day / alignment / position+time), warm, client p50/p99 ms [869hvq → dslqml] | day 102/185, alignment 369/1865, position (uncached) 97/193 | day 116/221, alignment 277/471, position 102/200; server-timing 4–5 ms |
| same, first request (miss), client p50/p99 · server p50 | day 143/167 · 13; alignment 245/371 · 13 | day 290/564 · 190; alignment 458/794 · 197 (cold blocks after the deploy: one BlockStore MISS = 62 of a 92 ms miss, trace c5f3de81…) |
| position now, client p50/p99 · server p50 | 88/224 · 0 (local) | 141/260 · 35 (forwarded, max-age=0: EXPIRED every time) |
| 50 concurrent identical cold requests [ulfgw7 → 55f09y] | day: 14 computed / 50, alignment 21/50; all 50 ran the Worker | day, alignment, position+time: 1 MISS + 49 HIT; telemetry: 50 front, **1** Api invocation (day, position). max-age=0 position-now: 50 front, 5 Api |
| `/v1/weather` 4 req/s × 4 (load.sh LOAD=weather, ~5 min) client p50/p99 | 91/318 | 148/396 (forwarded, Api max-age=0) |
| METAR feed tier mix | l1 99.4%, l1-stale 0.5% | hit 99.1%, updating 0.9%; 282 parses (Api isolates in many colos), cpu p50/p99 3/41 ms |
| upstream calls | 15 in 21 min (12 × 200 + parse, 3 × 304) | 7 in 7 min, max 1/min, all conditional (5 × 200, 2 × 304), upstream ms p50 41 |

**V2** (b49a8a02: live position/magnetic in the front door, weather Api `max-age=0, swr=300`, crossVersionCache), same
client and probes [bc0mlb/rferp2 + load 12:51:22–12:56:51Z]:

| | V2 (b49a8a02) |
| --- | --- |
| warm repeat day / position+time client p50/p99 · server | 93/194, 98/222 · 4 ms |
| miss (first) server p50 | day 143, position 42 ms |
| position now / magnetic now (front door) client p50/p99 · server | 97/207, 91/172 · 0 ms (back to the Cache API baseline) |
| weather repeated key | UPDATING from the 2nd request: server p50 4 ms; 50 concurrent: 50 × UPDATING, server 6 ms |
| 50 concurrent cold, day / position+time | 1 MISS + 49 HIT |
| weather load client p50/p99 | 134/325 (c72a360c 148/396, Cache API 91/318); 487 Api / 489 front invocations: random keys never repeat |
| feed tiers / upstream | hit 99.3%, updating 0.7%; 6 calls in 6 min, max 1/min, all conditional (4 × 200, 2 × 304) |

**Why forwarded weather is slower than the Cache API design** (proven from invocation colos, both versions): every front
door ran in EWR; the Api invocations behind them ran in IAD 60%, EWR 28%, ATL / ORD / MIA 12% (a MISS runs at the tier
colo). The front door's `api.fetch` p50 by Api colo: EWR 18–20 ms, IAD 31–32, ATL 42–43, ORD 51–60, MIA 57–63 (b49a8a02 and
c72a360c agree). Before, weather ran in-process (~1–2 ms). With unique lat/lon keys nothing hits, so every request pays
the loopback plus the tier round trip; SWR only helps a key that repeats.

**Weather in the front door** (1532ebd5, git cb48b35; same `LOAD=weather load.sh 1100`, 13:16:54–13:22:25Z): client p50/p90/p99
100/174/242 ms (Cache API 91/318, V2 134/325, c72a360c 148/396); server-timing p50 6–8 ms; front-door CPU p50/p99 2/14 ms;
the MetarFeed loopback (`metar.feed` span) p50/p90/p99 7/9/13 ms; feed hit 99.6%, updating 0.4%, 79 parses (EWR isolates
only; 243 when forwarded); upstream 6 calls in 6 min, max 1/min, all conditional (5 × 200, 1 × 304).

**Live checks of the CACHE_VERSION design (2026-10-29):** a key cached on 1721a525 (git 31b437c) was HIT on 04a4ea0c (same
commit, redeployed): entries survive a deploy. A fresh key on 04a4ea0c fetched its DE440 block as `blocks_hit` with an empty
isolate L1: blocks stay warm across deploys. After CACHE_VERSION 2 → 3 (dc5bcd23, git e2cdc1a) the same key was MISS, then
HIT (blocks MISS once too). The golden test caught the refraction change (31b437c bumped 1 → 2 and re-recorded).

Where things run: a MISS runs the cached entrypoint at the tier colo (Api invocations for EWR traffic: IAD 94, EWR 53, ORD
6, ATL 4, MIA 4 in one 5-min window, c72a360c), which is why a miss costs more wall than a front-door compute.

## Geoid bands (EGM96 from R2)

Every route with an observer (position, day, crossing, track; also MCP tools and the front door's live position) needs
the EGM96 undulation N, because `observer.geoidUndulation` is always in the answer and a missing `height` puts the observer
on the geoid. Since 2026-10-30 (CACHE_VERSION 4) alignment does too: `heightRef` / `targetHeightRef`, per-point
`geoidUndulation`, and the eye on the geoid by default; it loads every band within target lat ± maxDistanceKm (1–2 bands;
`geoidAcross` in handlers.ts). Magnetic, weather and the static routes do not. Until 2026-10-30 the 30′ grid was bundled
(`egm96-grid.ts`, 384 KB = 38% of the script); now the Worker bundles only its manifest (`packages/core/src/egm96-bands.ts`:
per band offset, length, sha256 prefix; 1.7 KB) and reads bands from R2:

```
handler ─ geoid.load (concurrent with blocks.load) ─ L1 (isolate Map, ≤ 46 bands) ─▶ loopback.ts geoid
          ─▶ BlockStore GET /geoid/v<CACHE_VERSION>/<sha16>/<band>  (Workers Caching, immutable)
          ─▶ R2 ephem-geoid  egm96-30/<sha16>.bin, exact range of that band
```

- **Granularity:** the existing 46 bands of 8 rows (5.6–6.6 KB each); a lookup reads 1 band, 2 when its rows straddle a
  band edge (`geoidBandsFor(lat)`). The band count is what decides fetches; bytes are tiny next to a round trip.
- **Integrity / fail closed:** BlockStore checks length + sha256 before answering (else 502 `no-store`); the consumer
  checks again before the band enters L1. Any failure is a typed **503 `GeoidUnavailable`** naming the band and the cause
  (in the contract for the five routes); nothing is cached and the next request retries. Core throws if a band was not
  prefetched, so a wiring bug can never answer with a wrong height.
- **Bit-identical:** same decoder over the same bytes. Golden test unchanged; sweep of 8.28 M lookups (random, every node
  and midpoint, every row/band edge ± 1e-9, poles, lon wrap) old bundled code vs new code over the bytes read back from R2:
  0 differ (`Object.is`), scratchpad `bundle/sweep.ts`, 2026-10-30.
- **Upload:** `node --experimental-strip-types scripts/geoid-r2.ts upload` (idempotent: reads the object back and skips if
  the sha matches; key carries the sha), `verify`, and `manifest` after `reference/geoid/make_grid.py` regenerates the grid.
  Bucket `ephem-geoid` (ENAM), binding `GEOID`. **Never** write to `ephem-de440`.
- **Tests:** no network. `test-setup.ts` installs the source-tree grid (`geoid-bundled.ts`, never imported by the Worker)
  as core's band source; `packages/worker/test/geoid.test.ts` injects the band fetch (fake R2, failing loopback, wrong
  bytes, concurrent dedupe).

## Alignment search (`POST /v1/alignment/search`, src/search.ts)

One POST in the front door → one `GET /v1/alignment/search/window` per 30-day window on the fixed UTC grid, all in parallel
through `loopback.ts api` (cached, immutable, cross-version like every Api answer) → merge, filter, include. The front door
does no astronomy; all CPU is in the window invocations (Api entrypoint, tier colo). Design and proofs: DESIGN.md §10.x.

**Spans**

| Span | Where | Attributes |
| --- | --- | --- |
| `search` | front door (POST handler) | `ephem.windows`, `ephem.windows_cache` (`HIT:12,MISS:2`; `LOCAL:n` in-process), `ephem.passes` (after filters), `ephem.passes_total`, `ephem.segments`, `ephem.region_vertices`, `ephem.span_days`, `ephem.search.anomalies` |
| `search.window.fetch` | front door, one per window | `ephem.window` (start), `ephem.api_cache` (the window's cf-cache-status), `http.status_code`, `ephem.api_key` (first 200 chars) |
| `search.window` | Api invocation (a MISS) | as every handler span: `blocks`, `reads`, `l1`, `ephem.isolate_computes`; plus `geoid.load` children |
| `compute.search` | Api invocation | `ephem.passes`, `ephem.region_vertices`, `ephem.search.<counter>`: `scanEvaluations`, `spans`, `spanSeconds`, `trackEvaluations`, `crossings`, `refineEvaluations`, `segments`, `anomalies` (must be 0), `maxSagittaM` |

The response repeats the counters (`search.counters`, summed over windows; a HIT returns the counts of the run that filled
it) and `search.windows[].cache`, so a client sees which windows computed.

**Measure** (by exact version; windows are Api invocations on path `/v1/alignment/search/window`, the POST is the front door):

```sh
python3 scripts/obs/cpu-by-version.py --minutes 20 --path /v1/alignment/search/window --entrypoint Api   # per-window CPU / wall
python3 scripts/obs/cpu-by-version.py --minutes 20 --path /v1/alignment/search                           # the front door's merge
python3 scripts/obs/trace.py --latest /v1/alignment/search                                              # fan-out tree
```

A cold scan needs keys nobody has cached: vary the target height or region by a centimetre (the region is quantised to
1e-7°, so move a vertex by ≥ 2e-7°). A repeat of the same body is all HITs and computes nothing.

**Measured (8a308729, git e1719ba, 2026-10-30, client EWR; scratchpad `search/bin/prod-scan.ts`, `live-ab.ts`).** The
customer's 12-month scan (Liberty 70 m MSL, the 424-node Brooklyn Bridge Park, eye 5 m MSL, 2026-10-30 → 2027-10-30) is
**1 call** (14 window GETs inside) against their ~150 calls / ~39 s:

| | Result |
| --- | --- |
| answer | 64 passes, 125 segments, anomalies 0; Nov 16 entry 2026-11-17T03:45:19.5Z, 40.703292, −73.996305 (prod geoid from R2) |
| cold scan (14 × MISS), client wall | 332–857 ms (n = 6, right after deploy, 12:58:37–12:58:41Z); p50 463 / p90 643 / max 1 086 ms under back-to-back load (n = 124, 12:59:56–13:00:56Z) |
| warm repeat (14 × HIT), client wall | 69–105 ms (n = 6) |
| Api CPU per window | fresh after deploy p50 111 / p90 203 / p99 308 ms (n = 83); sustained p50 51 / p90 155 / p99 273 ms (n = 823) |
| Api CPU per cold 12-month scan (sum of its windows) | ≈ 1.7 s fresh (10 153 ms / 6 scans), ≈ 1.0 s sustained (60 993 ms / 823 windows × 14); in 14 parallel invocations, so wall ≈ the slowest window |
| front door CPU per POST (merge) | p50 21–25 / p99 35–55 ms (n = 12, 118) |
| live `/v1/position` (front door) client latency, alone → during 124 cold scans/min | p50 38 → 38, p90 49 → 49, p99 69 → 232 ms (n = 249, 245) |

The p99 rise is the open item: ~2 % of live requests landed behind a front-door merge (25 ms CPU, mostly JSON of 14
windows that each repeat conventions, sun and phase) or a window computed in the same isolate. Next: slim the window body,
then re-run `live-ab.ts`.

## MCP (`/mcp`, src/mcp.ts)

Unauthenticated, stateless MCP over Streamable HTTP, written in Effect (no SDK). Dual-era: modern **2026-07-28**
(no handshake; `_meta["io.modelcontextprotocol/protocolVersion"]` + `clientCapabilities` on every request, mirrored in
`MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name`; methods `server/discover`, `tools/list`, `tools/call`) and legacy
**2025-11-25 / 2025-06-18 / 2025-03-26** (`initialize` negotiates; `ping`; notifications → 202; no `Mcp-Session-Id` is
minted; a request without `MCP-Protocol-Version` is 2025-03-26, the only version where batches are accepted). GET/DELETE
→ 405. Origin: absent (non-browser) or any https origin passes; plain http only from loopback or the same host; `null`,
`file:`, extension and malformed origins → 403. Tools (`sun_moon_position`, `day_events`, `crossing`, `alignment`, `sight_line`, `sun_moon_track`, `weather_nearest`, and `alignment_search`, whose arguments are the POST body)
decode arguments with the Type side of the REST query schema, encode them back to a query string with the same schema and
run the router's own `/v1/*` route in-process, so `inputSchema` / `outputSchema` are generated from `@ephem/api` and the
math is the REST code path (including the forward to the cached Api entrypoint).

Verify after every deploy:

```sh
node --experimental-strip-types scripts/obs/mcp-probe.ts https://ephem.ivar.workers.dev   # 37 checks, exit 1 on any FAIL
python3 scripts/obs/trace.py --jsonrpc-id <run>-legacy.call.day_events                    # span tree of one tool call
npx -y @modelcontextprotocol/inspector@2.13.0 --cli https://ephem.ivar.workers.dev/mcp --transport http --method tools/list
```

**Spans:** one `mcp.<method>` span per JSON-RPC message (`mcp.parse_error` for an unparseable body, `mcp.invalid` when
there is no method), a child of the router's `POST` span. A tools/call span is the parent of the REST handler span
(`position` / `day` / `crossing` / `alignment` / `weather`), which nests `compute.*`, `blocks.load` and `metar.*` as usual.

| Attribute | Meaning |
| --- | --- |
| `mcp.method`, `jsonrpc.id` | method and request id (`""` for notifications) |
| `mcp.protocol_version` | modern: the `_meta` version; legacy: the negotiated / header version (2025-03-26 when absent) |
| `mcp.requested_version` | initialize only: what the client asked for |
| `mcp.client` | `name/version` from initialize `clientInfo` or modern `_meta` clientInfo, when present |
| `mcp.tool`, `mcp.rest_status` | tools/call: tool name and the inner REST status |
| `mcp.error_code` | JSON-RPC error code, when the reply is an error |
| `mcp.is_error` | true for a JSON-RPC error or a tool result with `isError: true` |
| `mcp.batch`, `mcp.notification`, `http.status_code`, `mcp.origin_rejected` | transport details |
| `ephem.api_cache` | on the tools/call span for forwarded tools (the inner GET has no span of its own) |

Find calls with a raw query filter on `jsonrpc.id`, `mcp.tool` or `mcp.client` (e.g. `claude-code/2.1.312`). A filter on
`$metadata.transactionName = mcp.tools/call` returned only some of the matching spans (2026-10-29), so don't count with it.

## Request logs (Basin)

One row per request in an Iceberg table, queryable with SQL: **Basin Pipelines** (stream) → **Basin Catalog** (Iceberg on
R2 bucket `ephem-logs`, warehouse `5ad2236b39de4c8bd8f6270ea63f3ea9_ephem-logs`, namespace `ephem`) → **Basin SQL**.

| Resource | Name / id | Notes |
| --- | --- | --- |
| stream | `ephem_requests` `d43e9589a2784812afda39033b6792eb` | schema `packages/worker/ops/basin/requests.schema.json`; Worker binding on, HTTP off; binding `LOGS` |
| stream | `ephem_invocations` `2d45db937f214e5cae5c19ba4c099779` | schema `ops/basin/invocations.schema.json`; written by `ephem-tail` (binding `INVOCATIONS`) |
| Tail Worker | `ephem-tail` (packages/tail) | attached via `tailConsumers` in packages/worker/cloudflare.config.ts; deploy `cd packages/tail && cf deploy` |
| bucket / catalog | `ephem-logs`, catalog enabled | `credential_status: absent` until the R2 admin token exists |
| sinks, pipelines | `ephem_{requests,invocations}_sink`, `…_pipeline` → tables `ephem.requests`, `ephem.invocations`, roll 60 s | **not created yet**: they need an R2 Account API token (Admin Read & Write) at `~/.config/ephem/r2-admin-token` (chmod 600), then `python3 scripts/obs/basin.py provision` |

Stream schemas cannot change after creation; a new column means a new stream (and binding id). `basin.py types` regenerates
`src/basin.generated.ts` from the live schemas with `wrangler types`; the tests assert our row types are assignable to it and
check every key and type against the schema file. **A structured stream accepts a non-matching row and drops it later**
(`send()` still resolves), so those tests are the only guard; dropped rows show in `events.pipelinesUserErrors` once a
pipeline exists.

**How a row is made** (src/requestlog.ts). The `RequestLogging` global middleware (registered first, so it is outermost
and sees what `Gateway` forwards) runs the request under a tracer that delegates to the real one and keeps every span the
request creates. When the request finishes it reads those spans' attributes and exits, builds the row, and hands it to the
per-request sink: `ctx.waitUntil(env.LOGS.send([row]).catch(…))`. Nothing is awaited on the response path; a throwing
sink is caught. Handlers, MCP and weather need no logging code. The span attributes the row reads are listed in `ATTR`, and
renaming one breaks `test/requestlog.test.ts`. MCP's in-process `/v1` calls don't log rows of their own; their spans and
coordinates land in the outer `/mcp` row. OPTIONS preflights are answered before the router and have no row (ephem-tail
sees them). `REQUEST_LOGS: "off"` (text binding) turns rows off without a code change.

**Two roles** (`role` column). The front door (default entrypoint, uncached) writes one row for **every** request:
route, status, error, `api_cache`, client fields. The cached `Api` entrypoint writes a row each time it actually runs (a
Workers Caching miss or revalidation), with the work counts. It gets the front's ray as `x-ephem-ray`, so
`JOIN … ON f.ray = a.ray` pairs them. Count requests with `role = 'front'`, and read work from `role = 'api'`.

| Column | From | Notes |
| --- | --- | --- |
| `ts` | `Date.now()` at the end of the request | RFC 3339, ms |
| `ray`, `colo`, `country`, `city` | `cf-ray` (or `x-ephem-ray`), `request.cf` | |
| `version`, `build`, `role` | version-metadata binding, `__EPHEM_BUILD__`, entrypoint | |
| `method`, `route`, `status`, `ok` | request; `http.route`, or the path when it is one of the static routes (`ROUTES`) | never the raw path: unknown paths have no route |
| `error_tag` | the typed failure's `_tag` (`OutOfRange`, `InvalidInput`, `WeatherUnavailable`), `InvalidRequest` (schema 400, including unknown query parameters since 2026-10-29), `RouteNotFound`, a defect's name, or the JSON-RPC error name for MCP | |
| `wall_ms` | `performance.now()` around the request inside the Worker | the Workers clock is frozen during compute, so this is I/O wall, not total |
| `api_cache`, `blocks_cache`, `feed_cache` | `ephem.api_cache`, `ephem.blocks_cache` (e.g. `HIT:2,MISS:1`, `L1`), `ephem.feed_cache` | the internal loopbacks' cf-cache-status, verbatim |
| `blocks`, `blocks_mem` | `blocks.count`, `cache.l1` | blocks requested, and served from the isolate L1 |
| `origin_reads`, `origin_bytes` | Σ `cache.blocks_<status>`, `cache.fetchedBytes` | blocks fetched past L1 (any tier), and their bytes |
| `block_reads`, `iterations` | `ephem.block_reads`, `ephem.iterations` | work counts (api rows) |
| `weather_tier`, `data_age_s` | `metar.tier`, `metar.data_age_s` | `/v1/weather` |
| `mcp_method`, `mcp_tool` | `mcp.method`, `mcp.tool` | `/mcp` |
| `ua_family` | user agent / `mcp.client` | `curl`, `browser`, `mcp:<client name>`, `other` |
| `lat_r`, `lon_r` | `lat`/`lon` (or `targetLat`/`targetLon`; MCP tool arguments) | rounded to 0.01° (~1 km) |

**Privacy rules** (tested): no IP, no raw path or query string, no full user agent, coordinates rounded to 0.01°. MCP client
names are reduced to `[a-z0-9._-]{≤32}`.

**Tail Worker split.** A request that dies before its waitUntil runs (exceededCpu, exceededMemory, an uncaught exception)
writes no request row. `ephem-tail` gets one TailItem per ephem invocation (front, Api, BlockStore, MetarFeed) and writes
one `ephem_invocations` row per item: outcome, script_version, entrypoint, method, route (known route or `other`), status,
ray, colo, exception names and count, error-log count, `basin_send_failed` count (from the invocation's own logs) and
`cpu_ms` / `wall_ms`. It is a separate stream and table, not a `source` column, because the schemas differ, and Basin's
guidance is separate tables unless they match. Join on `ray`. **What a TailItem actually contains** (logged once per
isolate as `tail_item_shape`, 2026-10-29, ephem c72a360c): `cpuTime` and `wallTime` (numbers, ms, both present although
the handler docs don't list them), `entrypoint` (string for named entrypoints, absent for default), `event.{request{cf,
headers,method,url}, response{status}}`, `eventTimestamp`, `exceptions[]`, `logs[]`, `outcome`, `executionModel`,
`scriptName`, `scriptVersion{id,tag,message}`, `truncated`, `diagnosticsChannelEvents[]`; `dispatchNamespace`,
`durableObjectId`, `preview`, `scriptTags`, `tailAttributes` were undefined.

**Send cost and failures.** `send()` resolves once ingest is confirmed. On c72a360c the runtime span `jsRpcCall
method=send` took ~1 000–1 030 ms after every response (trace 3c1a9ec564a63837baee5e55e3cdb9be: Effect GET 92 ms,
send 1 017 ms, invocation wall 1 114 ms, cpu 3 ms). The response is not delayed, but **invocation `wallTimeMs` includes it**,
so while rows are on, `cpu-by-version.py`'s wall column is not latency. Use client time, the Effect `GET` span, or
`server-timing`. **A/B (2026-10-29, same tree, only `REQUEST_LOGS` flipped; `load.sh 150` + `LOAD=weather load.sh 60` each):**
off = 9d06f585-ceca-43c6-a533-3878f511fb63 (git c769b1d, 13:05:33–13:06:29Z), on = 67b61f4f-7d1b-426c-96dc-5073ad2e885a
(git a0529dc, 13:07:32–13:08:26Z). Client `time_total` p50/p99, off → on: alignment 314/936 → 294/831 ms, day 215/1028 →
178/540 ms, weather 145/316 → 154/425 ms (n 150/150/240). Api CPU p50/p99: alignment 37/178 → 34/140 ms, day 9/115 →
12/132, weather 3/59 → 4/59. Front-door CPU p99 ≤ 24 ms in both. **So logging moves neither client nor CPU p99** (the
differences are within run-to-run noise at n = 150). It moves invocation wall p50 from 33–86 to 543–632 ms (front and Api),
which is the send. 0 `basin_send_failed`. A failed send logs one line,
`{"basin_send_failed":{"stream","role","route","status","ray","error"}}`; count them with `python3 scripts/obs/basin.py
failures`. ephem-tail also counts them per invocation. Stream-side ingest metrics (`events.pipelinesSource`) stay empty
until a pipeline consumes the stream (checked 2026-10-29).

**Queries** (`python3 scripts/obs/basin.py sql <name> [--hours 1]`): `by-route` (requests and wall by version, route,
status), `api-cache` (Workers Caching status per route), `weather-tiers` (feed tier mix and data age), `work` (Api work by
route and block tier), `errors`, `clients`, `outcomes` (ephem_invocations: outcome per version and entrypoint), `latest`.
`basin.py crosscheck --from … --to …` prints front-row counts per (version, route, status) next to the o11y invocation
counts of the default entrypoint. **Lag:** a row reaches Iceberg only when the sink rolls a file (every 60 s, the
minimum), so the last minute or two are missing; compare closed windows. Basin SQL needs the same R2 admin token
(`WRANGLER_BASIN_SQL_AUTH_TOKEN`, set by basin.py from the token file and never printed).

## Rates (altitudeRate, azimuthRate)

One function, `topocentricRates` (packages/core/src/observe.ts), for /v1/position, /v1/alignment points (`ratesAt`) and
/v1/crossing: analytic from the DE440 Chebyshev velocity (design and terms: DESIGN.md "Rates"). /v1/track reports no rates.

- Accuracy: `node --experimental-strip-types scripts/obs/rate-accuracy.ts 200000 11` (offline, fixture blocks; `ROOT=<old
  worktree>` for a before/after). 2026-10-30, 200 000 samples, seed 11, `truth` = vs Richardson(30 s, 60 s), `test` = the
  property test's ±2 s statistic (bound 1e-5):

  | | truth alt (\|alt\| < 80) | truth az·cos | test, \|alt\| < 80 | test, nadir band (−89, −80) | test ≥ 1e-5, (−89, 80) | test ≥ 1e-5, last degree above the nadir |
  | --- | --- | --- | --- | --- | --- | --- |
  | ±10 s difference (e1719ba) | 1.0e-6 | 1.6e-6 | 3.6e-6 | 5.6e-5 | 51 | 15 |
  | analytic | 3.6e-7 | 3.9e-7 | 3.9e-6 | 3.1e-6 | 0 | 3 |

- Floors: a JD is one double, so instants round to 40 µs. That puts ~2.5e-6 °/min of noise into any ±2 s difference (the
  test's statistic) and ~2e-7 into the 30/60 s Richardson (it falls as 1/h from 15 s to 60 s, then truncation grows): the
  analytic rate is at or below what a difference of these positions can resolve.
- Within 1° of the zenith or nadir the ±2 s difference itself is off by > 1e-5 (cusp; measured 2.1e-5 at −89.6°), so
  properties.test.ts checks nothing there. The ±10 s rate's flake was the nadir side: every failure below −80°.
- Gotcha: aberrate returns a = (v + lt·V)/(1 + p) with |a| = |v|; differentiating the bracket without the 1/(1 + p) leaves
  the transverse rate high by p ≈ 1e-4 of the body's own motion (5e-7 °/min on the Moon, invisible on the Sun).
- fast-check: a failure prints `{ seed, path }`; `FC_SEED=<seed> npx vitest run packages/core/test/properties.test.ts`
  replays it (test-setup.ts; `CI=1` pins seed 42).

## Profiling

```sh
cf workers deployments list --worker ephem --per-page 1       # get the full version UUID
scripts/obs/profile.sh 4e7c34ee-3d60-460a-bf5e-a829e7558b52    # cpu, 10 s
go tool pprof -top -lines -nodecount=40 profiles/<file>.sym.pb
go tool pprof -peek 'evalBlock' -lines profiles/<file>.sym.pb  # callers and callees
go tool pprof -http=: profiles/<file>.sym.pb                   # flame graph in a browser
```

The underlying call is
`cf workers versions profile <version> --worker-id ephem --profile-type cpu|heap --duration-ms N > out.pb`. It writes raw,
uncompressed pprof protobuf to stdout.

**Profile an exact version.** Pass the full UUID, not `latest-deployed`, so a concurrent deploy can't put the profile on
a different build. Record that UUID next to every number.

**It needs an isolate executing when the request lands.** Otherwise it fails with
`[10393] No recent executions were found for this Worker`, even with plenty of traffic on that version minutes earlier.
That's why `profile.sh` starts load 5 s before the capture and keeps it running through it.

**What is in it:** about 10% of wall is sampled CPU (1,000–1,500 ms per 10 s capture under `load.sh`). Pseudo-frames:
`(garbage collector)`, `(program)`, `(idle)`. Native builtins appear under odd names: `set platform` turned out to be
`Object.defineProperty` setting `fn.name`.

**Api profiles rarely land.** The capture samples one isolate near you. Cached-entrypoint MISSes (Api) run at tier
colos (IAD, EWR, ATL, MIA, ORD for EWR traffic), spread over many isolates that each serve a handful of requests, so a
capture usually gets a front-door isolate (e4d16979 under `LOAD=track`: 299 ms sampled, no `track` frames) and at best one
Api isolate's few requests (fbdb337e: 20 ms sampled, `sky.trackRequest` 55%). For Api CPU, split invocation CPU by
isolate warmth (`cold-split.py`) and profile the first requests of a fresh Node process for the shape (below).

**Fresh-isolate analog in Node.** One Node process = one isolate. Profile exactly the first K requests after import
with `node:inspector/promises` (`Profiler.setSamplingInterval` 50 µs, `Profiler.start` right before the first request,
`Profiler.stop` right after); prod's fresh-isolate CPU ran ~4× the Node number (47 vs 12 ms, fbdb337e). A steady-state
Node bench (hundreds of requests in one process) measures a fully optimized JIT that prod Api isolates almost never reach.

**Load shape matters.** Two profiles are comparable only under the same load. For A/B numbers use `cpu-by-version.py`
on the same `load.sh` workload, not totals from two profiles.

### Source maps

cf uploads the bundle's source map by default, and Cloudflare applies it to profile locations, so frames read
`../core/src/block.ts:61`. Function names are not mapped. They are the runtime `fn.name`, which minification shortens
(`rq`, `Dae`), because we build with `keepNames: false`. Each frame's line is the function's definition line, so
`symbolize.py` reads the name from the source there (`block.evalBlock`, `alignment.standingPoint`,
`geodesic.directLine.<anon>` for a returned closure). `profile.sh` writes both the raw `.pb` and the `.sym.pb`.

A frame at `index.js:1:<col>` is code with no source mapping: bundler helpers. Build the same bundle with
`cd packages/worker && cf deploy --dry-run` and read `.cloudflare/output/v0/workers/default/bundle/index.js` at that
column.

## Findings so far (keep appending)

| Date | Version | Finding | Effect |
| --- | --- | --- | --- |
| 2026-10-29 | 9d06f585 → 67b61f4f | Basin request rows on: Pipelines `send()` runs ~0.5–1 s in waitUntil after every response. | client and CPU p99 unchanged; invocation wall p50 +~550 ms |
| 2026-10-29 | dbd3f184 → 98ba1ce8 | 21% of CPU in esbuild's `__name` helper (`index.js:1:36`): wrangler's default `keepNames` wrapped every closure the solvers create. Set `keepNames: false` in `wrangler.config.ts`. | alignment CPU p50 36 → 24 ms, p90 46 → 35 |
| 2026-10-29 | 4e7c34ee | Top frames after that: evalBlock 10%, enuOf 8%, GC 7%, itrsOf 6%, norm 6%, geodesic direct 6% / inverse 5%, bennett 5%. | next targets |
| 2026-10-29 | 80f5b087 | METAR baseline (Cache API L2): 7 344 /v1/weather in 21 min, l1 99.4% (wall p50/p99 1/9 ms), l1-stale 0.5% (9/324: the waitUntil refresh is billed to the triggering invocation), l2-fresh 3 (75/82, parse 45–48 ms cpu); 100% served without waiting on upstream. | baseline for the Workers Caching rewrite |
| 2026-10-29 | 80f5b087 → c72a360c | Cache API → Workers Caching (uncached front door, cached Api / BlockStore / MetarFeed). 50 identical cold requests: 14–21 computes → 1 Api invocation. Warm deterministic repeats: server 4–5 ms. Misses cost more (cold blocks, tier colo): day miss server p50 13 → 190 ms; max-age=0 live routes +35 ms. | V2: live in front door, weather SWR, crossVersionCache |
| 2026-10-30 | 84bb5548 → e4d16979 | Homepage fired 111 /v1 calls per load (106 timed /v1/position, one per 20-min grid point; they queued: p50 85–204 ms each for 27–34 ms of server work). Now one `/v1/track` (217 samples, 11.3 KB on the wire) + live position + today's day + weather (+ tomorrow's day only after today's last event). Track MISS Api CPU p50 12 / p90 60 / p99 109 ms (n=131), less than one /v1/day MISS (46/157); front-door live probe p50 33 ms during 120 cold track MISSes vs 42 alone. | paths drawn, 390×844 mobile, median: cold 761 → 438 ms, warm 96 → 73; Fast 3G + 4× CPU cold 3877 → 1620, warm 800 → 748 (scratchpad xhr/measure.mjs) |
| 2026-10-29 | 4e7c34ee | `/v1/day` miss: the Effect `GET` span starts about 10 ms after the runtime `GET` (trace ef493004…). Not yet explained. | explained 2026-10-30 (fbdb337e row): isolate start-up of a fresh Api isolate |
| 2026-10-30 | e4d16979 → fbdb337e | **/v1/track Api CPU "5–50× the 1.3 ms bench" is isolate warmth, not the math.** 242 cold-key MISSes (`LOAD=track`, 11:25:30–11:26:30Z): fresh isolates (empty L1; 37/38 of those are `isolate_computes = 1` on fbdb337e) n=42, CPU p50/p90 65/97 ms, 60% of all track CPU, and their Effect `GET` starts 123 ms (p50; p90 176) after the runtime `GET` (isolate start-up, wall; warm: 0); warm isolates p50 9. By isolate computes (fbdb337e, 11:37:55–11:38:40Z, n=240): 1 → p50 42, 2–5 → 11, 6–20 → 7, >20 → 5 ms; Node reaches 0.13 ms only after ~200 requests. Biggest fresh-isolate bucket in Node: the EGM96 grid decode, 6.5 of 18–19 ms (all 260 k nodes, one stream, for 4 nodes). Now 46 bands of 8 rows decoded on demand (≤ 2 per lookup; 2.26 M lookups bit-identical; +8 KB gzip). Blocks: 1 per homepage track, `HIT` 3–8 ms or L1; not a bucket. | fresh-isolate CPU p50/p90 65/97 → 47/84 ms (n 42 → 39, 11:36:55–11:37:40Z); Node first track 18–19 → 12 ms; warm unchanged (9 → 7–10) |
| 2026-10-30 | 8a308729 | New POST /v1/alignment/search: the customer's 12-month scan in 1 call. Cold 332–857 ms client (Api CPU ≈ 1.0–1.7 s summed over 14 parallel windows), warm 69–105 ms. Live position p50/p90 unchanged under 124 cold scans/min, p99 69 → 232 ms. | next: slim window JSON (front-door merge 25 ms CPU p50) |
| 2026-10-30 | e4d16979, fbdb337e | Cold e2e of a homepage track (curl from EWR, new connection, unique lat/lon, joined by cf-ray; scratchpad `track-prof/e2e-*.joined.json`). Fresh Api isolate, median (n=12 / 3): total 295 / 264 ms = TCP+TLS 39 / 42 + client↔edge 37 / 39 + front door 3 / 3 + loopback 206 / 159 [isolate start-up 108 / 95 + Api CPU 60 / 44 + blocks 4 / 5 + cache/tier round trip 25 / 14]. Warm Api isolate (n=18 / 25): 133 / 122 ms, loopback 36 / 31 (CPU 12 / 8, tier 24 / 22). | next: isolate start-up (~100 ms wall per fresh Api isolate; 1 MB bundle, local `cf workers check` 27 ms active) |
| 2026-10-30 | bee1a78f, 0d2d5eb6 (git 8de819d = fbdb337e code) → 5c337183 (3c87955) → 164e1cd7, 61305294 (0b88f9f) | **Bundle 985 → 616 → 402 KiB (gzip 451 → 205 → 139).** (1) EGM96 grid (384 KB string) to R2 (see "Geoid bands"). (2) Effect barrel imports → module subpaths + no unused HttpPlatform/FileSystem/Path layers: Effect 465 → 251 KB (Schema 67 → 11, mimeTypes/NetAddress/hashMap/dateTime/Optic/Path/FileSystem/Dns/JsonPatch → 0; per-module table scratchpad `bundle/modules-before-after.tsv`, from the source map with `bundle/smap-bytes.mjs`; esbuild metafile `bundle/meta-*.json`). Left: Multipart/Cookies/Channel/Stream/Queue ~17 KB kept by the HttpServerRequest/Response classes, OpenApi + JSON Schema ~24 KB (/openapi.json, MCP), runtime + SchemaAST ~56 KB, home.ts 60 KB. Local `cf workers check` (6 alternating runs, median active / window): 24.0 / 41.0 → 23.9 / 40.7 → 22.3 / 34.0 ms; deploy-reported startup 53, 58 → 38 → 39, 48 ms. | **Fresh Api isolate (`cold-split.py`, LOAD=track 120 rounds right after each deploy), pre-router gap p50/p90: 117/248 (n 49) → 109/179 (n 26) → 99/158 ms (n 43)**; base → 402 KiB median −18 ms, bootstrap 95% CI [−37, +2]. First-request CPU p50/p90 51/97 → 61/79 → 57/92 ms (unchanged within noise; CI of the diff [−8, +15]); warm CPU p50 10–11 everywhere. The gap is mostly not script size: −59% bytes bought ~15% of the gap; ~100 ms of isolate start-up remains. String bytes are ~free (the grid's removal moved neither `workers check` nor the gap measurably); code bytes cost (~7 ms local window for 214 KB of Effect). |
| 2026-10-30 | same versions | Cold e2e of a homepage /v1/track (a geoid route: every observer route needs N) from EWR, fresh connection + fresh Api isolate, median: base 319 ms (n 14; server 227, gap 122, CPU 51) → geoid 352 (n 15; server 220, gap 120, CPU 61, geoid.load 11) → both 289 (n 28; server 179, gap 90, CPU 51, geoid.load 6). Warm isolate 131 / 146 / 141 (n 35 / 15 / 20). `geoid.load` over 1 185 spans 12:28–12:41Z: L1 0 ms (24%), HIT p50/p90/p99 5/17/41 (HIT:2 6/28/47), **MISS p50/p90 134/289** (5%, R2 ENAM from the tier colo; once per band per tier, immutable + crossVersionCache); concurrent with blocks.load (HIT 4–6 ms), so a HIT adds ~1–2 ms wall and a MISS ~130 ms. 0 5xx. | next: isolate start-up is platform-side; home.ts 60 KB is the largest piece left |

## Gotchas

- The tracing API's `setStatus` takes `{ code: "ok" | "error" }`, not a string. A string threw in prod (9d24dd65, about
  2 min of 500s). Every tracing call is now wrapped so it can't fail a request; see `safe()` in `src/trace.ts`.
- `wrangler.config.ts` (used by cf) spells build options in camelCase (`keepNames`); `keep_names` is rejected.
  `wrangler deploy --dry-run` reads `wrangler.jsonc` instead, so verify bundle changes with `cf deploy --dry-run`.
- `cold-split.py` / `cpu-by-version.py` right after a load run undercount (196 of 240 Api rows at +60 s, 240 at +5 min): ingest lags; wait a few minutes before the final numbers.
- Use unique windows or places for load; otherwise Workers Caching answers (`x-ephem-cache: HIT`, no Api invocation at
  all) and you measure the cache, not the code.
- Workers Caching keys the Api by path + query (sorted by the front door) + `cf.cacheKey`; the host is not in the key, and
  `cf` on a Request copy is dropped in Node, so the front door passes it in fetch's second argument as the docs do.
- A cache-enabled entrypoint's response without Cache-Control is cached heuristically (a router 404 was HIT for 3 min on
  fd72f501). The Api sets `no-store` on anything without one (`defaultNoStore`).
- A Workers Caching MISS runs the cached entrypoint where the tier is, not where the eyeball is: Api invocations for EWR
  traffic ran in IAD, EWR, ORD, ATL, MIA (c72a360c).
- `scripts/deploy.sh` before 2026-10-30 had two holes: the worktree's `node_modules/@ephem/*` resolved to the shared tree
  (uncommitted core/api changes were tested and bundled), and `typecheck && lint && test` let a failing typecheck skip lint
  and tests (3c87955 shipped that way; test-only type error). Both fixed (8de819d, 66c8256).
- Re-deploying an older rev for an A/B is a rollback: it replaced another agent's fresh deploy (19405fee, git 8159032) for
  ~2 min on 2026-10-30. Check `cf workers deployments list` immediately before every A/B deploy, and restore after.
- `/v1/day` needs `tz`; `/v1/position` takes `time` optionally (default now).
- `/v1/track` rejects a start/end off the stepSeconds grid (422 naming the snapped values): snap on the client so keys are
  shared. The homepage's live poll has no `time`: with one it would be forwarded and leave a single-use immutable entry.
- Invocation `wallTimeMs` includes waitUntil: with Basin request rows on, every invocation carries a ~1 s `send` (see
  "Request logs (Basin)"), so compare wall only between versions with the same `REQUEST_LOGS` setting.
- MCP: the probe and Inspector speak legacy 2025-11-25; Claude Code 2.1.312 speaks 2026-07-28 directly (no initialize).
  Both must keep working; the probe covers both eras.
