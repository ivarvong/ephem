# Telemetry and profiling

How to see what prod ephem is doing: traces, per-version CPU numbers, and CPU/heap profiles. Every command here has been
run against prod. **Keep this file current:** when a command, flag, span, attribute or gotcha changes, update it in the
same change, and add the date to "Last verified".

Last verified: 2026-10-29 (version 4e7c34ee; crossing span + MCP probe b49a8a02; MCP section 68c58ae5; Caching section c72a360c).

## The loop

instrument → gate green → deploy (`cd packages/worker && cf deploy --message "…"`) → smoke → drive uncached load →
**measure by exact version** (`cpu-by-version.py`, `trace.py`, `profile.sh`) → fix the biggest measured bucket → repeat.
Every number you report carries its version id (and trace id or profile file). Log runs in
`~/code/lab_notebook/ephem-deploy-2026-10-28.md`.

## Tools (`scripts/obs/`)

| Tool | What it gives you |
| --- | --- |
| `python3 scripts/obs/cpu-by-version.py [--minutes 30] [--path /v1/alignment] [--version 80f5b087] [--entrypoint Api] [--from ISO --to ISO]` | CPU and wall p50/p90/p99 per (version, entrypoint, path, status) from invocation events; entrypoint is `default` (front door), `Api`, `BlockStore` or `MetarFeed`. The A/B tool. `--path` is sent as a server-side filter (the events view caps at 1000 rows per query); `--from/--to` pin an absolute window. Wall includes waitUntil: see "Request logs (Basin)". |
| `python3 scripts/obs/basin.py status\|failures\|provision\|sql <name>\|crosscheck\|types` | Basin request logs: resources, `basin_send_failed` counts, sink/pipeline provisioning, canned Basin SQL, Basin-vs-o11y counts. See "Request logs (Basin)". |
| `python3 scripts/obs/trace.py <traceId>` or `--latest /v1/day` | One request: invocation CPU/wall, the Effect span tree with work counts, and the runtime's own spans (fetch, jsRpc, R2). The front door and the Api invocation it called are two traces sharing one cf-ray (the Api's ends in its colo, e.g. `-IAD`). |
| `scripts/obs/profile.sh <full-version-uuid> [cpu\|heap] [ms]` | Drives uncached load, captures a prod profile of that exact version, symbolizes it, prints the top. Files land in `profiles/` (gitignored). |
| `scripts/obs/load.sh [rounds] [base]` | Uncached load: per round, one 24 h Moon alignment and one `/v1/day`, each with a fresh window or place so the Api cache misses. `LOAD=weather` instead sends 4 `/v1/weather` requests per round (random land-weighted lat/lons, n = 1–3), ~16 req/s. |
| `python3 scripts/obs/metar-cache.py [--minutes 30] [--version 80f5b087] [--slice 2]` | METAR feed cache: per (version, tier) request count, share, wall and CPU p50/p99, parses, data age; upstream calls (MetarFeed's `{"evt":"metar.upstream"}`) by status, conditional, and per minute. Joins each `{"evt":"metar"}` log line to its invocation on `$metadata.requestId`. |
| `python3 scripts/obs/cache-probe.py [base] --mode repeat\|unique\|burst [--keys 10] [--repeats 5] [--burst 50] [--routes day,…]` | Client-side cross-check of Workers Caching: per request `x-ephem-cache` (the Api's cf-cache-status relayed by the front door), client and server-timing latency; p50/p99 by (route, status). `burst` fires N concurrent identical cold requests (collapsing test); count Api invocations for that key with a `starts_with` filter on `$workers.event.request.url = https://api.internal/<path>?<sorted query>`. |
| `node --experimental-strip-types scripts/obs/mcp-probe.ts [base]` | Full MCP client session against `/mcp` (legacy handshake + modern 2026-07-28 flow + error cases); every tool call (5 tools, incl. `crossing`) is checked equal to its REST endpoint, plus the REST 400 UnknownParameter and a null `apparentAltitude` case. Pass/fail table with latency and cf-ray. Run after every deploy. |
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
| `alignment` / `day` / `position` | handlers (Api invocation) | `blocks`, `reads`, `l1`, `blocks_<status>`, `fetchedBytes` |
| `compute.<endpoint>` | handlers | `ephem.block_reads`, `ephem.instants`, `ephem.iterations`, `ephem.track_points`, `ephem.events`, `ephem.crossings` (compute.crossing) |
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
             ├─ GET /v1/day, /v1/alignment, /v1/position|magnetic with time, /v1/weather
             │     ─▶ loopback.ts api: Api.fetch(path + sorted query, { cf: { cacheKey: "/v<CACHE_VERSION>" + path + query } })
             │        Api (cache ON) ─▶ blocks: loopback.ts block  GET /block/v<N>/<sha16>/<i>  (BlockStore, cache ON) ─▶ R2 range read
             │                      └▶ weather: loopback.ts feed  GET /feed/v<N>/metars.cache.csv.gz (MetarFeed, cache ON) ─▶ aviationweather.gov
             └─ live (position / magnetic without time): computed in the front door (blocks via BlockStore as above)
```

A HIT never runs the cached entrypoint, so it leaves no Api invocation, trace or log; the front door always runs and
records the Api's `cf-cache-status` as `ephem.api_cache` (span) / `api_cache` (Basin row) and relays it to clients as
`x-ephem-cache`. Hit rates are therefore server-side observable; `cache-probe.py` is the client-side cross-check.

**Cache-Control** (src/responses.ts, tests in test/responses.test.ts):

| Route | Api (what Workers Caching stores) | Outward (browsers) | Why |
| --- | --- | --- | --- |
| `/v1/day`, `/v1/alignment`, `/v1/crossing` (window or date), `/v1/position` + `time`, `/v1/magnetic` + `time` | `public, max-age=31536000, immutable` | same | pure function of the query; CACHE_VERSION is in the key and is bumped when answers change |
| `/v1/weather` | `public, max-age=0, stale-while-revalidate=300, stale-if-error=3600` | `private, max-age=30` | a hot key answers from cache at most one request (≤ 5 min) behind, plus the feed's 60 s |
| `/v1/position`, `/v1/magnetic` without `time` | not forwarded (`API_LIVE` = `public, max-age=0` if called directly) | `no-store` / `public, max-age=3600` | max-age=0 forwarding measured +35 ms server p50 with no sequential hits (below) |
| any non-200 from the Api, or no Cache-Control | `no-store` | `no-store` | errors are never cached (a router 404 was heuristically cached for 3 min on fd72f501) |
| `/` | — (never forwarded) | `private, no-store` | the sky at request.cf's location; the cache key ignores request.cf |
| `/docs`, `/openapi.json` | — | `public, max-age=300` | cheap; served by the front door |
| `/mcp` | — (POST; tool calls go through the same forward) | — | |
| BlockStore `/block/v<N>/<sha16>/<i>` | `public, max-age=31536000, immutable` | — | blocks never change for a file hash (in the path) |
| MetarFeed `/feed/v<N>/metars.cache.csv.gz` | `public, max-age=60, stale-while-revalidate=600, stale-if-error=86400` | — | upstream regenerates ~1/min; ≤ 10 min stale while one revalidation runs; a day of upstream outage still answers (STALE) |

**Keys and versions.** Workers Caching keys by entrypoint + path + query (+ ctx.props, + version unless
`crossVersionCache`); the host is not in the key, nor are other request headers (the forwarded `x-ephem-ray` is not: two
rays, same query → MISS then HIT, c72a360c). `crossVersionCache` is Worker-wide (it "applies to every entrypoint whose
cache is on"). It is on (ivar, 2026-10-29: "Turn on cross version, but we keep our own version tag in code if we need to
bump"), so cached answers, blocks and the feed survive deploys, and the only partition is **`CACHE_VERSION`** in
`src/cache-version.ts`, carried by every loopback key: Api `cf.cacheKey` = `/v<N>` + path + sorted query, BlockStore
`/block/v<N>/<sha16>/<i>`, MetarFeed `/feed/v<N>/…`. Two guardrails:

- `src/loopback.ts` is the only code that fetches our entrypoints; `test/loopback.test.ts` scans `src/` and fails on any
  other read of a binding off `ctx.exports`.
- `test/golden.test.ts` hashes the bodies (minus provenance / diagnostics) of a fixed set of deterministic requests (day,
  position + time, alignment, crossing, magnetic + time) into `test/golden/answers.json` with the CACHE_VERSION they were
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

Workers Caching v2 (live in front door, weather SWR, crossVersionCache + build-scoped Api keys): see the lab notebook
entry of 2026-10-29 for its numbers.

Where things run: a MISS runs the cached entrypoint at the tier colo (Api invocations for EWR traffic: IAD 94, EWR 53, ORD
6, ATL 4, MIA 4 in one 5-min window, c72a360c), which is why a miss costs more wall than a front-door compute.

## MCP (`/mcp`, src/mcp.ts)

Unauthenticated, stateless MCP over Streamable HTTP, written in Effect (no SDK). Dual-era: modern **2026-07-28**
(no handshake; `_meta["io.modelcontextprotocol/protocolVersion"]` + `clientCapabilities` on every request, mirrored in
`MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name`; methods `server/discover`, `tools/list`, `tools/call`) and legacy
**2025-11-25 / 2025-06-18 / 2025-03-26** (`initialize` negotiates; `ping`; notifications → 202; no `Mcp-Session-Id` is
minted; a request without `MCP-Protocol-Version` is 2025-03-26, the only version where batches are accepted). GET/DELETE
→ 405. Origin: absent (non-browser) or any https origin passes; plain http only from loopback or the same host; `null`,
`file:`, extension and malformed origins → 403. Tools (`sun_moon_position`, `day_events`, `alignment`, `weather_nearest`)
decode arguments with the Type side of the REST query schema, encode them back to a query string with the same schema and
run the router's own `/v1/*` route in-process, so `inputSchema` / `outputSchema` are generated from `@ephem/api` and the
math is the REST code path (including the forward to the cached Api entrypoint).

Verify after every deploy:

```sh
node --experimental-strip-types scripts/obs/mcp-probe.ts https://ephem.ivar.workers.dev   # 28 checks, exit 1 on any FAIL
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
`server-timing`. A failed send logs one line,
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
| 2026-10-29 | dbd3f184 → 98ba1ce8 | 21% of CPU in esbuild's `__name` helper (`index.js:1:36`): wrangler's default `keepNames` wrapped every closure the solvers create. Set `keepNames: false` in `wrangler.config.ts`. | alignment CPU p50 36 → 24 ms, p90 46 → 35 |
| 2026-10-29 | 4e7c34ee | Top frames after that: evalBlock 10%, enuOf 8%, GC 7%, itrsOf 6%, norm 6%, geodesic direct 6% / inverse 5%, bennett 5%. | next targets |
| 2026-10-29 | 80f5b087 | METAR baseline (Cache API L2): 7 344 /v1/weather in 21 min, l1 99.4% (wall p50/p99 1/9 ms), l1-stale 0.5% (9/324: the waitUntil refresh is billed to the triggering invocation), l2-fresh 3 (75/82, parse 45–48 ms cpu); 100% served without waiting on upstream. | baseline for the Workers Caching rewrite |
| 2026-10-29 | 80f5b087 → c72a360c | Cache API → Workers Caching (uncached front door, cached Api / BlockStore / MetarFeed). 50 identical cold requests: 14–21 computes → 1 Api invocation. Warm deterministic repeats: server 4–5 ms. Misses cost more (cold blocks, tier colo): day miss server p50 13 → 190 ms; max-age=0 live routes +35 ms. | V2: live in front door, weather SWR, crossVersionCache |
| 2026-10-29 | 4e7c34ee | `/v1/day` miss: the Effect `GET` span starts about 10 ms after the runtime `GET` (trace ef493004…). Not yet explained. | open |

## Gotchas

- The tracing API's `setStatus` takes `{ code: "ok" | "error" }`, not a string. A string threw in prod (9d24dd65, about
  2 min of 500s). Every tracing call is now wrapped so it can't fail a request; see `safe()` in `src/trace.ts`.
- `wrangler.config.ts` (used by cf) spells build options in camelCase (`keepNames`); `keep_names` is rejected.
  `wrangler deploy --dry-run` reads `wrangler.jsonc` instead, so verify bundle changes with `cf deploy --dry-run`.
- Use unique windows or places for load; otherwise Workers Caching answers (`x-ephem-cache: HIT`, no Api invocation at
  all) and you measure the cache, not the code.
- Workers Caching keys the Api by path + query (sorted by the front door) + `cf.cacheKey`; the host is not in the key, and
  `cf` on a Request copy is dropped in Node, so the front door passes it in fetch's second argument as the docs do.
- A cache-enabled entrypoint's response without Cache-Control is cached heuristically (a router 404 was HIT for 3 min on
  fd72f501). The Api sets `no-store` on anything without one (`defaultNoStore`).
- A Workers Caching MISS runs the cached entrypoint where the tier is, not where the eyeball is: Api invocations for EWR
  traffic ran in IAD, EWR, ORD, ATL, MIA (c72a360c).
- `/v1/day` needs `tz`; `/v1/position` takes `time` optionally (default now).
- Invocation `wallTimeMs` includes waitUntil: with Basin request rows on, every invocation carries a ~1 s `send` (see
  "Request logs (Basin)"), so compare wall only between versions with the same `REQUEST_LOGS` setting.
- MCP: the probe and Inspector speak legacy 2025-11-25; Claude Code 2.1.312 speaks 2026-07-28 directly (no initialize).
  Both must keep working; the probe covers both eras.
