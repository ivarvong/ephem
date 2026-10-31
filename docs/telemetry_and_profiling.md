# Telemetry and profiling

How to see what prod ephem is doing (traces, logs, CPU by version, profiles), how to ship and roll back, and the gotchas
that still bite. Every command here was run against prod on the date in "Last verified". **Keep this file current:** when
a command, flag, span, attribute or gotcha changes, update it in the same change. Dated investigations and superseded
numbers go to the lab notebook, not here (the history up to 2026-10-31 is in
`~/code/lab_notebook/ephem-telemetry-history-2026-10-31.md`).

Last verified: 2026-10-31, ephem d489af37 (git 4aae603: routes without `/v1`), every command below run from a clean
worktree of main. Exceptions are marked *not re-run*.

## The loop

Commit → `ship.sh` deploys it (gate, 0% canary, telemetry gate, promote, live gate, auto-rollback) → drive load →
**measure by exact version** (`cpu-by-version.py`, `trace.py`, `profile.sh`) → fix the biggest *user-visible* bucket →
repeat. Every number you report carries its version id (and trace id, run id or profile file). Performance work only when
a trace shows a user-visible problem.

| I want to… | Run |
| --- | --- |
| see one request | `python3 scripts/obs/trace.py --latest /day` or `trace.py <traceId>` |
| see one page view, client + server | `node --experimental-strip-types scripts/obs/journey.ts https://ephem.ivar.workers.dev/ --device iphone --cold` |
| see a real user's page view | `node --experimental-strip-types scripts/obs/trace-view.ts --latest --real` |
| CPU / wall by version and route | `python3 scripts/obs/cpu-by-version.py --minutes 30 [--version <id>] [--path /day]` |
| where the CPU goes | `scripts/obs/profile.sh <full version uuid>` |
| query request logs (SQL) | `python3 scripts/obs/basin.py sql by-route --hours 1` |
| check prod end to end | `scripts/smoke.sh https://ephem.ivar.workers.dev` |
| ship / see the pipeline | commit to main; `scripts/ship.sh status`, `scripts/ship.sh log` |
| roll back | `ALLOW_OLDER=1 scripts/deploy.sh <good rev> "rollback: <why>"` (see "Ship and roll back") |
| load from Cloudflare, several regions | `node --experimental-strip-types scripts/obs/load-remote.ts --mode mixed --rate 60 --duration 60 --regions enam,weur,apac` |

All scripts shell out to the `cf` CLI (OAuth as ivar). Reading profiles needs `go` (`go tool pprof`). Ingest lag: a trace
or log is queryable ~10–30 s after the request; invocation counts are complete after a few minutes.

## Tools

`scripts/obs/` unless noted. The `.py` tools share `telemetry.py` (one `cf o11y telemetry query` per call, 3 retries, ≤ 6
concurrent queries per process; `events_all` reads an absolute window in full by splitting at the 1 000-row cap and
fails loudly rather than returning a partial result).

| Tool | What it gives you |
| --- | --- |
| `python3 trace.py <traceId>` / `--latest <path>` / `--jsonrpc-id <id>` | One request: invocation CPU/wall/outcome, the Effect span tree rebuilt from `effect.parent_id`, and the runtime's spans (fetch, jsRpc, R2). The front door and an Api invocation it called are two traces sharing one cf-ray. `--jsonrpc-id` finds one MCP message (the probe's ids are `<run>-<step>`). |
| `python3 cpu-by-version.py [--minutes 30] [--path /alignment] [--version <id>] [--entrypoint Api] [--from ISO --to ISO] [--json out]` | CPU and wall p50/p90/p99 and CPU sum per (version, entrypoint, path, status). Entrypoints: `default` (front door), `Api`, `BlockStore`, `MetarFeed`, `Og`. `--path` is a server-side filter; `--from/--to` read the window in full. Wall includes waitUntil (the Basin send). The A/B tool. |
| `scripts/obs/profile.sh <version uuid> [cpu\|heap] [ms]` | Drives `load.sh`, captures a prod profile of that exact version, symbolizes it (`symbolize.py`), prints the top. Files in `profiles/` (gitignored). See "Profile". |
| `python3 queue_wait.py --from ISO --to ISO [--path /position] [--over 20] [--version id] [--json out]` | Server-side wait before the handler ran (Effect request span start − runtime request span start), per request, tagged **new isolate** or **busy isolate**. Use it instead of client p99 for "did X slow Y down". `--path /internal/alignment-search-window` for search windows. |
| `python3 cold-split.py --from ISO --to ISO [--route track] [--json out]` | Api CPU by isolate warmth (`ephem.isolate_computes`: 1 = the isolate's first computation) and the pre-router gap (isolate start-up). |
| `python3 cache-probe.py [base] --mode repeat\|unique\|burst [--keys 10] [--repeats 5] [--burst 50] [--routes day,…]` | Client-side check of Workers Caching: `x-ephem-cache`, client and server-timing latency per (route, status). `burst` fires N concurrent identical cold requests: the only test of request collapsing (expect 1 MISS + N−1 HIT). |
| `python3 metar-cache.py [--minutes 30] [--version id] [--slice 2]` | METAR feed: tier mix (hit / updating / miss / revalidated / stale), wall and CPU, data age, parses; upstream calls by status and per minute. |
| `python3 basin.py status\|failures\|sql <name>\|crosscheck\|types\|create-streams\|provision\|teardown` | Basin request logs. See "Request logs (Basin)". |
| `node --experimental-strip-types mcp-probe.ts [base]` | Full MCP session against `/mcp` (legacy handshake + modern 2026-07-28 flow + error cases); every tool call checked equal to its REST endpoint. Pass/fail table with cf-rays. Part of the smoke. |
| `scripts/smoke.sh <base> [--pin <id>] [--expect <id>] [--expect-compute <id>] [--only a,b] [--run id --manifest file]` | Every route + content checks + the MCP probe, concurrently. See "Ship and roll back". |
| `python3 canary-gate.py ephem <new> <prev> --since ISO --run ID --manifest FILE [--live 90] [--early 0.75] [--until ISO] [--json out]` | deploy.sh's telemetry gate. Not run by hand normally. |
| `python3 tail-check.py [--minutes 10] [--version <id>] [--wait 90] [--require /track,…]` | ephem-tail health from its own o11y events: invocations by (version, outcome), `basin_send_failed`, route labels. deploy.sh runs it after a tail deploy. |
| `node --experimental-strip-types journey.ts <url> [--device iphone\|desktop] [--net fast3g\|4g\|none] [--cpu 4] [--cold\|--warm] [--script home-drag\|none] [--duration 70] [--out dir]` | Unified client+server trace of one page view through our CDP client (`cdp/`). See "Page views". `--rebuild <name>.raw.json` after a model/viewer change. |
| `node --experimental-strip-types trace-view.ts <client trace id>\|--latest [--real] [--out dir]` | A real page view rebuilt from production RUM + request rows + o11y; same viewer. |
| `[SIZES=390,375] node --experimental-strip-types home-states.ts <base> <outDir> [filter]` | Screenshots of `/` in every sky state (debug `?at=`), light and dark, with the chart's label layout from `window.__sky` (overlaps, dropped, crossed: must be empty). |
| `node --experimental-strip-types load-remote.ts …`, `python3 load-check.py load-runs/<run>.json` | Remote load and its server side. See "Load". |
| `scripts/obs/load.sh [rounds] [base]` | Laptop load for `profile.sh` (fresh keys, so the Api misses): default alignment + day; `LOAD=track`, `LOAD=search`, `LOAD=weather`. |
| `<venv>/bin/python -I scripts/check-magvar.py --nasr-zip <DD_Mon_YYYY_APT_CSV.zip> [--metar …] [--csv out]` | Our WMM2025 declination vs FAA NASR airport magnetic variation, pygeomag and IGRF-14. Re-run each 28-day NASR cycle. Venv: `numpy ppigrf pygeomag`. |
| `node --experimental-strip-types scripts/geoid-r2.ts upload\|verify\|manifest` | EGM96 bands in R2 (see "Geoid bands"). |
| `node --experimental-strip-types scripts/openapi.ts`, `scripts/fonts/din.py`, `node --experimental-strip-types scripts/og/assets.ts` | Generators: reference/openapi.json; src/din.ts (the inline font: `python3 -I scripts/fonts/din.py <D-DIN.otf> <D-DIN-Bold.otf> <OFL.txt> packages/worker/src/din.ts`, needs fonttools + brotli; *not re-run*); the touch icon + fallback card (src/og-png.generated.ts, `--glyph-lib <glyph clone>`; *not re-run*). |

## Traces (one request)

Workers traces are on (`observability.traces: { enabled: true, headSamplingRate: 1 }`), so every request is traced.
`src/trace.ts` maps the Effect `Tracer` onto workerd's `tracing` API. **The tracing API can't nest spans under Effect
fibers**, so every Effect span is a direct child of the request span; the tree is rebuilt from `effect.span_id`,
`effect.parent_id`, `effect.parent` (`trace.py` and the journey viewer do this).

**Frozen clock.** Timers don't advance during pure compute, so `compute.*` spans read 0 ms. Only I/O-bound spans
(`api.fetch`, `blocks.load`, `geoid.load`, `metar.feed`, loopbacks) have real durations. For compute, read the span's work
counts and the invocation's `cpuTimeMs`; for where the CPU goes, profile.

| Span | Source | Key attributes |
| --- | --- | --- |
| `GET` / `POST` (Effect, front door) | HttpRouter | `http.route`, `ephem.api_cache` (the Api's cf-cache-status; `LOCAL` when computed in the front door; `LOOPBACK_ERROR`), `client.*` (see "Page views") |
| `api.fetch` | src/responses.ts | `ephem.api_key` (path + sorted query), `ephem.api_cache`, `http.status_code`: the whole loopback, real ms |
| `position` / `day` / `track` / `crossing` / `alignment` / `sightline` / `weather` / `magnetic` | handlers | `blocks`, `reads`, `l1`, `blocks_<status>`, `fetchedBytes`, `ephem.isolate_computes` (1 = fresh isolate) |
| `compute.<endpoint>` | handlers | work counts: `ephem.block_reads`, `ephem.instants`, `ephem.iterations`, `ephem.track_points`, `ephem.events`, `ephem.crossings`, `ephem.obstacles` |
| `blocks.load` | src/blocks.ts | `blocks.count`, `ephem.blocks_cache` (`L1`, or `HIT:2,MISS:1`), `cache.l1`, `cache.blocks_<status>`, `cache.fetchedBytes` |
| `geoid.load` | src/geoid.ts (every route with an observer; alignment: each band within target lat ± maxDistanceKm) | `geoid.bands` (1, or 2 at a band edge), `geoid.l1`, `geoid.<status>`, `geoid.fetchedBytes`, `ephem.geoid_cache`; concurrent with `blocks.load` |
| `loopback.trace` | src/loopback.ts | BlockStore / MetarFeed loopbacks: the calling span's traceparent |
| `metar.feed`, `metar.nearest` | src/weather.ts | `metar.tier` (MetarFeed cf-cache-status, lower-cased; `stale-on-error`), `ephem.feed_cache`, `metar.data_age_s`, `metar.bytes`, `metar.parsed`, `metar.version`, `metar.stations`, `metar.error`; `metar.nearest_km`, `metar.n` |
| `search`, `search.window.fetch`, `search.window`, `compute.search` | src/search.ts | see "Alignment search" |
| `mcp.<method>` | src/mcp.ts | see "MCP" |
| `home.embed`, `home.og`, `html.stream` | src/home.ts, src/embed.ts | see "Homepage" |
| `og.front`, `og.render` | src/og.ts | see "Link previews" |
| `GET` (runtime) | workerd | `cpu_time_ms`, `wall_time_ms`, `cloudflare.ray_id`, `outcome`, geo |
| `fetch` / `jsRpcCall` (runtime) | workerd | a loopback fetch; `jsRpcCall method=send` is the Basin pipeline send (~0.5–1 s, after the response) |

**Raw queries** when the scripts don't cover it (`--body` JSON; `--parameters-filters` flags are rejected; timeframe
bounds must be integers):

```sh
NOW=$(($(date +%s)*1000))
cf o11y telemetry query --body '{"queryId":"adhoc","timeframe":{"from":'$((NOW-600000))',"to":'$NOW'},
  "view":"events","limit":200,"parameters":{"filters":[
  {"key":"$metadata.service","operation":"eq","type":"string","value":"ephem"},
  {"key":"$metadata.traceId","operation":"eq","type":"string","value":"<traceId>"}]}}'
```

Views: `events` (invocations: `$metadata.type = cf-worker-event`; spans: `span`; logs: `cf-worker`), `traces`,
`calculations`. Keys: `$workers.cpuTimeMs`, `$workers.wallTimeMs`, `$workers.outcome`, `$workers.scriptVersion.id`,
`$workers.entrypoint`, `$workers.event.request.url`, `$workers.event.request.headers.<name>`,
`$workers.event.response.status`, `$metadata.traceId`, `$metadata.message` (`includes` works). Spans carry the version as
`source.cloudflare.script_version.id` and the entrypoint as `source.cloudflare.entrypoint`; filter root spans by ray with
`cloudflare.ray_id`. At most 1 000 rows per query.

## Page views (client + server)

Every page view carries one W3C trace id from the browser through every server entrypoint, for real users (production
RUM) and for the lab harness (our own CDP client). Design: DESIGN §12.2. Code: src/clienttrace.ts, src/servertiming.ts,
src/rum.ts, scripts/obs/cdp/, journey.ts, trace-view.ts.

**Propagation.**

| Where | What |
| --- | --- |
| document `/` | the front door adopts a valid `traceparent` (strict W3C, lower case, non-zero) or uses the root request span's trace id; returns `<meta name="traceparent" content="00-<trace>-<root span>-01">`, `Server-Timing: trace;desc="…"`, `x-ephem-trace`; `<meta name="ephem-synthetic">` when the request had `x-ephem-load` / `x-ephem-smoke` |
| page boot | reads meta → navigation `serverTiming` → fresh id (`window.__ephemTrace.from`) |
| every fetch (`__tfetch`) | `traceparent: 00-<trace>-<new span>-01`, `tracestate: ephem=<document span>` |
| root Effect span (front, Api) | `client.trace_id`, `client.span_id`, `client.parent_id`; documents: `client.document_span_id`, `client.trace_origin` (`adopted` / `minted`). Only the root: in-process router calls (`http://ephem.internal`: the homepage's embeds, MCP's tools) skip ClientTrace |
| loopbacks | Api: the client's header; BlockStore, MetarFeed: the calling span's traceparent (`loopback.trace`). A block or band fetch shared by concurrent requests carries the trace of the request that started it |
| never | anything beyond the two ids, tracestate other than `ephem=<16 hex>`, anything malformed (test/clienttrace.test.ts) |

Query: spans with `client.trace_id = <id>` give every trace of the view; Basin `ephem.requests.trace_id` and
`ephem.rum.trace_id` join by SQL.

**Server-Timing** (every front-door response): `trace`, `ray;desc="<cf-ray>"`, `api;desc="HIT";dur=`, `api-blocks` /
`api-geoid` (a fresh Api run only: a cached answer would replay another request's numbers), `blocks;desc="L1 n=2";dur=`,
`geoid`, `feed`, `total;dur=` (I/O wall). Durations are the Workers clock: wall around I/O, never CPU. **No CPU entry:**
CPU is not readable inside a request; it is `cpuTimeMs` in o11y. `Timing-Allow-Origin: *`; exposed headers
`server-timing, x-ephem-trace, x-ephem-version, x-ephem-cache`.

**Production RUM** (src/rum.ts, inline on `/`, no deps): navigation and every resource (Resource Timing + `serverTiming`),
FCP, LCP, CLS, INP, long animation frames, every fetch with its span ids, app spans `boot`, `data-ready`,
`first-sky-draw`, interactions. Batches go to `POST /rum` (sendBeacon on pagehide / hidden, keepalive fetch every 15 s and
2 s after data-ready).

| `/rum` rule | Value |
| --- | --- |
| body | ≤ 64 KiB (413), JSON object, `tp` a valid traceparent (400), `page` `/`, ≤ 300 spans (413) |
| rate | ≤ 30 batches per trace per minute, ≤ 600 per 10 s per isolate (429; best effort) |
| privacy | DNT / GPC → nothing sent or stored; sampled flag `00` → nothing; no IP, no UA (family only), no URL or query (targets are route ids, `/assets/<known file>`, `other`, `external`) |
| synthetic | `x-ephem-load`, `x-ephem-smoke`, `navigator.webdriver`, or `<meta name="ephem-synthetic">` → `synthetic = true` |
| storage | Basin stream `ephem_rum` → `ephem.rum`, one row per span (schema ops/basin/rum.schema.json) |

```sql
-- client spans joined to server request rows (basin.py sql --raw "…")
SELECT r.kind, r.name, r.target, r.start_ms, r.dur_ms, q.route, q.status, q.api_cache, q.wall_ms
FROM ephem.rum r LEFT JOIN ephem.requests q ON q.trace_id = r.trace_id AND q.client_span_id = r.span_id AND q.role = 'front'
WHERE r.trace_id = '<id>' ORDER BY r.start_ms
```

**The harness.** scripts/obs/cdp/ (no deps): cdp.ts (launch Chrome with a temp profile, one browser WebSocket, typed
`send`, events, teardown on every exit path), page.ts (navigate, iPhone 390×844@3 / desktop 1440×900@2, Fast 3G / 4G, CPU
throttling, cold cache, tap / drag / key, screenshots, Tracing, Network recorder), server.ts (o11y pull + ingest polling),
model.ts (join, clock offset, critical path, costs, Perfetto), viewer.ts.

```sh
node --experimental-strip-types scripts/obs/journey.ts https://ephem.ivar.workers.dev/ --device iphone --cold   # Fast 3G + 4× CPU by default on iphone
node --experimental-strip-types scripts/obs/journey.ts https://ephem.ivar.workers.dev/ --device desktop --warm --duration 75
node --experimental-strip-types scripts/obs/trace-view.ts <client trace id>   # a view from RUM + server telemetry only
node --experimental-strip-types scripts/obs/trace-view.ts --latest --real     # the newest non-synthetic RUM view
```

journey.ts gives the document the harness's traceparent via Fetch interception (documents only; not
`Network.setExtraHTTPHeaders`, which would give every fetch the same span id), and puts `x-ephem-load: <run>` on every
request. Then it drives (`home-drag`), dwells to `--duration`, leaves the page (pagehide → RUM beacon), takes unthrottled
clock probes, pulls the server side (polls until every root span and every MISS's Api invocation is in), pulls the page's
RUM rows and checks them against CDP. Outputs `<name>.html` (self-contained viewer), `.perfetto.json` (ui.perfetto.dev),
`.model.json`, `.rum.json`, `.png`.

**The viewer: only recorded data** (ivar, 2026-10-31: "render what actually happened"). A waterfall tree on one time axis
(browser clock, ms since navigation start; server spans shifted by θ with a ± whisker). A bar's start and end are recorded
events (CDP, a span's start/end, a RUM entry, an invocation event); a missing end is drawn open-ended ("end not recorded"),
never capped or extended; derived values say "derived" in the detail panel, and nesting says whether it is recorded
(`effect.parent_id`, Workers parent id, cf-ray) or inferred (time containment). The detail panel names each source.

| Element | Start → end |
| --- | --- |
| request bar (CDP) | `Network.requestWillBeSent` → `loadingFinished` / `loadingFailed`; phases from `responseReceived.timing` |
| request bar (RUM) | `startTime` → `startTime + duration`; dns/connect/tls are durations only and are not drawn |
| front door | root span start → first byte (`cloudflare.response.time_to_first_byte_ms`) → for a streamed document the streaming body to the `html.stream` span end → a thin line to the invocation end (waitUntil, labelled with what kept it alive) |
| Effect spans, subrequests, loopbacks, Basin send | span start → end (else `durationMS`, else open-ended); the Basin send is the only hatched bar. Frozen clock: subrequests print `I/O <n> ms`, Effect spans with I/O below them print `—` |
| main thread | CDP trace `X` events (RUM: LoAF / longtask / event rows); self time is derived |
| FCP, LCP, DCL, load, data drawn | CDP marks; user timing `ephem:data`, `ephem:embedded` / `ephem:fetched` |
| critical path (cyan) | recorded links only: document → first byte → embed complete → `ephem:embedded` → `ephem:data` and the tasks containing them; none, with the reason, when a mark is missing |

Keys: ↑↓ rows, ←→ fold, Enter detail, W S A D, 0 whole, 1 load, C critical, Z zoom to row, Esc. At ≤ 480 px the waterfall
fits and opens on the critical path.

**Clock offset** (model.ts). Each request with a server root span bounds θ = server − client: the span starts after the
browser sent (t2 > t1 + θ) and its first byte leaves before the browser had the headers (t3 < t4 + θ); θ is the midpoint
of the intersection over all requests, ± ≈ RTT/2 at best. Throttled runs add 12 unthrottled `/healthz` probes. Independent
check: `sntp time.apple.com` (printed by journey.ts). macOS slews its clock: measure per run.

**Harness gotchas.** Under DevTools throttling CDP's `receiveHeadersEnd` includes the emulated latency (RUM's
`responseStart` is the real first byte; they differ by ~the emulated latency). A pagehide beacon shows in CDP as
`net::ERR_ABORTED` though the server stored it (model.ts joins `/rum` by order). Headless INP is not comparable to headed.
In the viewer template (a `String.raw`): no backticks or `${`, and `/* */` comments only (a `//` inside a one-line function
blanked the viewer).

## Ship and roll back

**ship.sh** (ivar: "Ship every commit fast"). `scripts/ship.sh start` runs a watcher in its own session (pid
`.git/ephem-ship/pid`, output `.git/ephem-ship/ship.out`). Every 2 s it compares `main` with the last `deployed/` tag;
when main is ahead (and isn't the head that already failed) it runs `scripts/deploy.sh <main> "ship <n>: …" auto`.
Commits that land during a deploy coalesce into the next. One line per deploy in `~/code/lab_notebook/ephem-ship.log`
(stage timings, `commit->100%`), plus a `live <sha> <ver> ok|ROLLED-BACK …` line when the live verdict is in. A failure
leaves the head unshipped (main blocks until a newer commit passes) and sends a macOS notification. Commands: `status`,
`stop` (a running deploy and live watcher finish first), `restart`, `log [n]`, `retry` (re-try a flaked head), `once
<rev>`. Not launchd: its environment lacks the cf OAuth / node / pyproj PATH, and it would resume after an unwatched reboot.
The gate's pyproj comes from `~/.cache/ephem-gate-venv` (created by `start`).

**deploy.sh** `<rev> "<message>" [auto|ephem|tail|load|all]` (`DRY=1`: gate only). Two stages: the shared tree's copy only
takes the lock, refuses to go backwards (`ALLOW_OLDER=1`), adds a worktree of `<rev>` and execs **that commit's**
deploy.sh, so deploy logic, smoke and gate always come from the commit (an uncommitted deploy.sh once ran another agent's
deploy). Replace the shared copy only by an atomic `mv`. Then, from the commit:

1. Link node_modules (workspace packages point at the worktree's own `packages/`); gate (typecheck, lint, tests in
   parallel; skipped when the same tree + node_modules already passed: `.git/ephem-gate-pass/`, `NO_GATE_CACHE=1`) while
   `cf workers versions create` uploads the version (an uploaded version is in no deployment, so nothing reaches it).
2. **ephem-tail** first when targeted (`auto`: packages/tail, packages/worker/src/routes.ts or the invocations schema
   changed since the last `deployed-tail/` tag, or `tailConsumers` changed): `cf deploy`; after ephem's smoke,
   `tail-check.py --require <routes>` must pass, else ephem-tail is routed back. Tag `deployed-tail/<ts>`.
3. **ephem-load** when targeted (`auto`: packages/load changed since the last `deployed-load/` tag): `cf deploy`, then
   `/health` from the new version (target, limits), POST /run without the token → 401, an over-limit `/plan` → 400, a
   10-request run; else routed back. Tag `deployed-load/<ts>`.
4. **ephem**: wait for the previous deploy's live watcher (`.git/ephem-live.lock`); record the 100% version (a split
   deployment aborts); route new 0% + previous 100%; wait for 5 pinned `/healthz` in a row from the new version; **pinned
   smoke** (`--pin`: `Cloudflare-Workers-Version-Overrides`, every response must carry the new `x-ephem-version`); **canary
   telemetry gate** (early pass); promote; wait for 5 unpinned `/healthz` from it; **live smoke**; tag `deployed/<ts>`.
   Prod traffic never sees a canary that fails. Any failed smoke check is retried once (only the failures, after `RETRY_S`
   = 5 s); still failing → canary removed, or (after promotion) route 100% back, re-smoke the restored version with its own
   commit's smoke.sh, exit 1, no tag.
5. A detached **live watcher** (log `.git/ephem-live/<sha>-<ts>.log`, verdict `.git/ephem-live/<sha>.result`; `LIVE_WAIT=1`
   keeps it in the foreground) re-runs the canary gate in full (`--until` promotion) and the **live gate** (the live smoke
   + 90 s of real traffic, `O11Y_LIVE_S`), plus the tail check. Failure → rollback to the recorded previous version,
   tag deleted, notification. The next deploy waits for the verdict.
6. A diff touching non-versioned settings (`tailConsumers`, `observability`, `logpush` in cloudflare.config.ts;
   `GRADUAL=0` forces it) skips the 0% stage and uses `cf deploy`; the live smoke and rollback still apply (a rollback
   restores code, not those settings).

**Why pinning is trustworthy.** Version overrides apply to versions in the current deployment, including at 0%; the front
door sets `x-ephem-version` from the VERSION binding; a pinned front door's `ctx.exports` loopbacks run the pinned version
too (smoke's `compute` check requires `x-ephem-compute-version` = the version under test).

**The telemetry gate** (`canary-gate.py`; ivar: "use a 0% version … run the full smoketest, via the o11y with cf cli,
before progressing").

- **Selection.** Every smoke request carries `x-ephem-smoke: <run>` (curl checks and MCP probe) and is listed in a manifest
  (`<cf-ray> <status> <method> <path> <check>`). The gate selects front-door invocations by that header (live traffic
  can't pollute it), joins Api invocations by `x-ephem-ray` and BlockStore by rayId prefix, then pulls every span and log
  of those traces (`$metadata.traceId` `in`, comma-joined). At 0% it also reads every invocation and log of the new version.
- **Two records per request:** the invocation event and the runtime root span are ingested independently; either counts as
  visible.
- **Pass:** early (`--early 0.75`) at 0 errors + every required span/entrypoint + 75 % of the requests visible; full check
  ≥ 95 % visible and every smoke check with at least one visible request (missing telemetry never passes; `--wait 90`).
- **FAIL:** outcome ≠ ok; any 5xx or a server status that differs from the client's; any log at level error, any key
  ending `_failed`, any `{"evt":"*_failed"}`; a smoke request answered by another version; missing `GET`/`POST`/`api.fetch`
  spans, `mcp.initialize` + `mcp.tools/call`, an Api invocation with `position` + `blocks.load`, a BlockStore invocation
  when an Api `blocks.load` reports a MISS (smoke `blocks-miss` asks for a random instant in 1972–2149), a linked
  Api/BlockStore invocation on another version.
- **WARN only: CPU** (new p50 > 2× the previous version's and +5 ms, or new max > previous p99 + 50 ms, n ≥ 10): the smoke
  sends 1–3 requests per route to fresh isolates, so no threshold separates start-up from a regression at that n.
- **Live:** an error on real traffic fails only if its signature (service, entrypoint, kind, path) did not occur on the
  previous version in its last 15 min; a pre-existing signature or a user's `canceled` outcome is a warning.
- **`x-ephem-errors`:** the front door counts `console.error` lines and unhandled rejections per isolate and returns the
  count on requests carrying `x-ephem-smoke`; a pinned canary's isolates serve only the smoke, so the smoke and the probe
  (`isolate.errors`) fail on any non-zero count with no ingest wait. Not on the Api (its responses are cached).
- `SKIP_O11Y_GATE=1` skips the gate (emergencies only; deploy.sh prints a banner). `O11Y_WAIT_S`, `O11Y_LIVE_S`,
  `O11Y_EARLY` override 90 / 90 / 0.75.

**Smoke checks** live in the deployed commit's `scripts/smoke.sh`: add one with every new route. Bodies are written to
files and grepped there (see "Gotchas": `curl | grep -q`). `compute` / `compute-hit`: a never-seen deterministic key is a
MISS computed by the Api, then a HIT. `og` / `og-hit`: a never-asked place renders a real glyph PNG (2400×1260, 20–300 KB),
then HITs. `not-found`, `window-internal`: 404s.

**Roll back by hand.** Find the good commit (`git tag --list 'deployed/*' --sort=-refname | head`), then
`ALLOW_OLDER=1 scripts/deploy.sh <rev> "rollback: <why>"` (the full pipeline, from that commit). Stop ship.sh first
(`scripts/ship.sh stop`) or it will redeploy main. Emergency without a gate: `cf workers deployments create` routing
100% to the previous version id (`route` in deploy.sh shows the body). Check `cf workers deployments list --worker ephem
--per-page 1` before and after.

## Load

Use unique keys, or Workers Caching answers (`x-ephem-cache: HIT`, no Api invocation) and you measure the cache.

**Laptop** (`load.sh`): only for `profile.sh` and quick checks. Laptop client p99 can't measure a server tail (idle
phases ranged 84–525 ms p99 from EWR, link stalls); use `queue_wait.py` and invocation CPU joined by cf-ray.

**Remote** (`ephem-load`, packages/load): open-loop load from Generator Durable Objects in several regions at once.

```sh
node --experimental-strip-types scripts/obs/load-remote.ts --mode mixed --rate 60 --duration 60 --regions enam,weur,apac \
     [--pin ephem=<version id>] [--warmup 10] [--seed 1] [--mix position=40,warm=30,track=15,weather=14,search=1] [--shards N] [--plan]
python3 scripts/obs/load-check.py load-runs/<run>.json        # >= 5 min after the end (ingest lag)
```

`POST /run` on `https://ephem-load.ivar.workers.dev` (Bearer `LOAD_TOKEN`) validates the spec, the Coordinator DO admits
it, and `shards` Generator DOs per region start with a location hint (new objects every run). Every shard starts at the same
instant, sends arrival *i* at `start + (i + shard/shards)/rate`, never waits, and drops (counts) an arrival that finds 6 in
flight. The warmup runs the same schedule and is counted apart. Per kind: a 1 % log histogram of client ms, statuses,
`x-ephem-cache`, `x-ephem-version`, the answering colo and a reservoir of `[ray, ms, status, t]` (for load-check). Ctrl-C
stops the run. Writes `load-runs/<run>.json`.

| mode | requests |
| --- | --- |
| `position` | `GET /position?lat=40.7&lon=-74` (live, front door) |
| `warm` | 24 fixed day / track / alignment keys, prewarmed by every shard: HITs |
| `track` | homepage-shaped `/track` (72 h from a UTC midnight) at a fresh lat/lon |
| `weather` | `/weather` at a random land-weighted lat/lon |
| `search` | `POST /alignment/search`, 12-month Brooklyn Bridge Park scan at a fresh target height |
| `mixed` | position 40, warm 30, track 15, weather 14, search 1 (`--mix` to change) |

Cold keys come from a PRNG seeded by the run id and shard, so they are new every run. Every request carries
`x-ephem-load: <run>` (o11y: `$workers.event.request.headers.x-ephem-load`; Basin rows `synthetic = true`). The live gate
counts load traffic as traffic.

**Limits** (packages/load/src/workload.ts `LIMITS`, enforced by the Worker, tested): one target,
`https://ephem.ivar.workers.dev`; no host, path or header in the spec; unknown fields refused; pins a full version uuid;
≤ 300 req/s total, ≤ 64 per region, scans ≤ 4/s, ≤ 600 s, warmup ≤ 60 s, ≤ 60 000 requests per run and 150 000 per hour,
≤ 5 regions, one run at a time. One Generator drives ~6.5 req/s before fetches queue inside the object, so the plan puts
≤ 4 req/s on a shard (scans 1.5/s). ephem-load needs `global_fetch_strictly_public` (a fetch between two workers.dev
Workers is otherwise refused). The token is in `~/.config/ephem-load/token` (0600); `scripts/obs/load-token.sh` rotates it
(delete the file first) and never prints it.

**What load-check says:** (1) front-door invocations with the run's header vs the client's count (they should match);
(2) per sampled request, server e2e (runtime request span start → Effect request span end) joined on cf-ray; (3) client vs
server per (region, kind). Client − server is the generator, egress and edge: compare arms run at the same time (pin both
and interleave), same `--seed` and regions.

## Profile

```sh
cf workers deployments list --worker ephem --per-page 1         # the full version UUID
scripts/obs/profile.sh d489af37-21bd-4088-98d8-50f5239ae974      # cpu, 10 s; LOAD=track|search for those paths
go tool pprof -top -lines -nodecount=40 profiles/<file>.sym.pb
go tool pprof -peek 'evalBlock' -lines profiles/<file>.sym.pb    # callers and callees
go tool pprof -http=: profiles/<file>.sym.pb                     # flame graph
```

Underneath: `cf workers versions profile <version> --worker-id ephem --profile-type cpu|heap --duration-ms N > out.pb`
(raw pprof on stdout). Pass the full UUID, not `latest-deployed`, so a concurrent deploy can't put the profile on another
build.

- **It needs an isolate executing when the request lands**, else `[10393] No recent executions were found`: profile.sh
  starts load 5 s before the capture and keeps it running (and retries).
- **~10 % of wall is sampled CPU.** Pseudo-frames `(garbage collector)`, `(program)`, `(idle)`; native builtins have odd
  names (`set platform` was `Object.defineProperty` setting `fn.name`).
- **Api profiles rarely land.** The capture samples one isolate near you; Api MISSes run at tier colos over many isolates,
  so you usually get the front door. For Api CPU use `cpu-by-version.py --entrypoint Api` and `cold-split.py`, and
  profile the first requests of a fresh Node process for the shape: one Node process = one isolate;
  `node:inspector/promises`, `Profiler.setSamplingInterval` 50 µs around exactly the first K requests (prod fresh-isolate
  CPU ran ~4× Node's). A steady-state Node bench measures a JIT prod Api isolates rarely reach.
- **Compare like with like:** two profiles only under the same load; for A/B numbers use `cpu-by-version.py`.
- **Source maps.** cf uploads the bundle's map and Cloudflare applies it to locations (`../core/src/block.ts:61`), but
  function names stay minified (`keepNames: false`, see "Gotchas"); each frame's line is the function's definition line,
  so `symbolize.py` reads the name from the source there. A frame at `index.js:1:<col>` is unmapped bundler code: build
  with `cd packages/worker && cf deploy --dry-run` and read `.cloudflare/output/v0/workers/default/bundle/index.js`.

## Request logs (Basin)

One row per request in Iceberg tables, queryable with SQL: Basin Pipelines (stream) → Basin Catalog (Iceberg on R2 bucket
`ephem-logs`, warehouse `5ad2236b39de4c8bd8f6270ea63f3ea9_ephem-logs`, namespace `ephem`) → Basin SQL.

| Resource | Name / id | Notes |
| --- | --- | --- |
| stream | `ephem_requests` `09e37fce…` | schema packages/worker/ops/basin/requests.schema.json; binding `LOGS` (one send per request, front and Api roles) |
| stream | `ephem_rum` `0c3797ae…` | ops/basin/rum.schema.json; binding `RUM` (src/rum.ts) |
| stream | `ephem_invocations` `2d45db93…` | ops/basin/invocations.schema.json; written by `ephem-tail` (binding `INVOCATIONS`) |
| Tail Worker | `ephem-tail` (packages/tail) | attached via `tailConsumers`; route labels from packages/worker/src/routes.ts (one list with the request row) |
| sinks, pipelines | `<stream>_sink`, `<stream>_pipeline` → `ephem.requests`, `ephem.rum`, `ephem.invocations`, roll 60 s | `basin.py status` lists them |
| token | `~/.config/ephem/r2-admin-token` (R2 admin, 0600) | basin.py passes it on stdin or in the child's env, never prints it |

```sh
python3 scripts/obs/basin.py status                         # streams, sinks, pipelines, catalog, token present
python3 scripts/obs/basin.py failures --minutes 60          # basin_send_failed / request_log_failed (ephem, ephem-tail)
python3 scripts/obs/basin.py sql by-route --hours 1         # also: api-cache weather-tiers work errors clients outcomes latest; --raw "SELECT …"; --json
python3 scripts/obs/basin.py crosscheck --from <iso> --to <iso>   # front rows vs o11y default-entrypoint invocations
python3 scripts/obs/basin.py types                          # regenerate src/basin.generated.ts from the live schemas
```

**Lag:** a row reaches Iceberg when the sink rolls a file (every 60 s, the minimum): compare closed windows.

**How a row is made** (src/requestlog.ts). The `RequestLogging` global middleware (outermost) runs the request under a
tracer that keeps every span the request creates; at the end it reads their attributes (`ATTR`; renaming one breaks
test/requestlog.test.ts), builds the row and calls `ctx.waitUntil(env.LOGS.send([row]).catch(…))`. Nothing is awaited on
the response path. MCP's in-process calls land in the outer `/mcp` row. OPTIONS preflights have no row (ephem-tail sees
them). `REQUEST_LOGS: "off"` turns rows off without a code change.

**Two roles.** The front door writes one row for **every** request (route, status, error, `api_cache`, client fields);
the cached Api writes one each time it actually runs (a miss or revalidation), with work counts, and gets the front's ray
as `x-ephem-ray`, so `JOIN … ON f.ray = a.ray` pairs them. Count requests with `role = 'front'`; read work from
`role = 'api'`.

| Column | From |
| --- | --- |
| `ts`, `ray`, `colo`, `country`, `city` | end of request; `cf-ray` (or `x-ephem-ray`), `request.cf` (synthetic rows' country/city are the Workers egress's) |
| `version`, `build`, `role` | version-metadata binding, `__EPHEM_BUILD__`, entrypoint |
| `method`, `route`, `status`, `ok` | `http.route`, or the path when it is in `ROUTES`; never a raw path |
| `error_tag` | the typed failure's `_tag`, `InvalidRequest` (schema 400, incl. unknown parameters), `RouteNotFound`, a defect's name, or the JSON-RPC error name |
| `wall_ms` | `performance.now()` around the request: I/O wall, not total |
| `api_cache`, `blocks_cache`, `feed_cache` | the loopbacks' cf-cache-status, verbatim |
| `blocks`, `blocks_mem`, `origin_reads`, `origin_bytes`, `block_reads`, `iterations` | block and work counts |
| `weather_tier`, `data_age_s`, `mcp_method`, `mcp_tool`, `ua_family` | weather, MCP, `curl` / `browser` / `mcp:<client>` / `other` |
| `synthetic` | `x-ephem-load` or `x-ephem-smoke` |
| `trace_id`, `span_id`, `client_span_id`, `client_parent_id`, `trace_origin` | src/clienttrace.ts; joins `ephem.rum` |
| `lat_r`, `lon_r` | rounded to 0.01° (~1 km) |

**Privacy** (tested): no IP, no raw path or query, no full user agent, coordinates rounded to 0.01°, MCP client names
reduced to `[a-z0-9._-]{≤32}`.

**The tail Worker** catches what request rows miss: a request that dies before its waitUntil (exceededCpu,
exceededMemory, an uncaught exception) writes no row. `ephem-tail` writes one `ephem_invocations` row per invocation of any
entrypoint: outcome, script_version, entrypoint, method, route (known or `other`), status, ray, colo, exception names and
count, error-log count, `basin_send_failed` count, `cpu_ms`, `wall_ms`. Join on `ray`. Each tail() call logs
`{"tail_batch":{"rows":n,"routes":["<entrypoint> <route> <n>",…]}}` (read by tail-check.py). A TailItem has `cpuTime` and
`wallTime` (ms), `entrypoint` (absent for default: labelled `-`), `event.{request,response}`, `exceptions[]`, `logs[]`,
`outcome`, `scriptVersion`.

**Send cost.** `send()` resolves once ingest is confirmed: the runtime span `jsRpcCall method=send` runs ~0.5–1 s after
every response. The response is not delayed and client latency and CPU p99 don't move (measured A/B, 2026-10-29), but
**invocation `wallTimeMs` includes it**: use client time, the Effect request span or Server-Timing for latency. A failed
send logs `{"basin_send_failed":{…}}` (counted by `basin.py failures` and the gate).

**Changing a schema.** Stream schemas are immutable and names unique, so a column change replaces the stream in place,
same name, no `_v2` (prerelease: the table's rows are dropped; ivar, 2026-10-31). Do it when no deploy or live watcher runs
(`scripts/ship.sh status`), quickly: between (1) and the deploy the live version's sends fail.
(1) `git rm` ops/basin/created-<stream>.json, then `basin.py teardown <stream> --drop-table` (pipeline, sink, stream,
table; prints the row count); (2) `basin.py create-streams <stream>`; (3) `basin.py provision <stream>`; (4) the new id in
cloudflare.config.ts, `basin.py types`, commit. *Not re-run* (last done 2026-10-31 for `ephem_requests` and `ephem_rum`).
**A structured stream accepts a non-matching row and drops it later** (`send()` still resolves): the schema tests are the
only guard; drops show in `events.pipelinesUserErrors`.

## Caching (Workers Caching; never the Cache API)

No `caches.default` anywhere (`grep -rn "caches\." packages/worker/src` is empty). Caching is Workers Caching in front of
the entrypoints whose `exports` entry enables it (cloudflare.config.ts), driven only by the Cache-Control they return.

```
eyeball ─▶ default (cache OFF: always runs → every request has its trace, Basin row, request.cf; `/` and `/mcp` live here)
             ├─ GET /day, /alignment, /track, /sightline, /crossing, /position|/magnetic with time, search windows
             │     ─▶ loopback.ts api: ctx.exports.Api.fetch(path + sorted query, { cf: { cacheKey: "/v<CACHE_VERSION>" + path + query } })
             │        ─▶ Api (cache ON) ─▶ blocks: GET /block/v<N>/<sha16>/<i>   (ctx.exports.BlockStore, cache ON) ─▶ R2 ephem-de440
             │                         └▶ geoid:  GET /geoid/v<N>/<sha16>/<band> (ctx.exports.BlockStore, cache ON) ─▶ R2 ephem-geoid
             ├─ live (position / magnetic without time): computed here; blocks / geoid via BlockStore
             ├─ /weather: computed here; feed via GET /feed/v<N>/metars.cache.csv.gz (ctx.exports.MetarFeed, cache ON) ─▶ aviationweather.gov
             └─ /og.png: ctx.exports.Og (cache ON) ─▶ Api answers + glyph (service binding)
```

A HIT never runs the cached entrypoint (no invocation, trace or log); the front door records the callee's
`cf-cache-status` as `ephem.api_cache` / `api_cache` and relays it as `x-ephem-cache`, so hit rates are observable server
side. A MISS runs the cached entrypoint at the tier colo, not the eyeball's (EWR traffic: IAD, EWR, ORD, ATL, MIA), which
is why a miss costs more wall than a front-door compute.

**Cache-Control** (src/responses.ts, test/responses.test.ts):

| Route | Api (what Workers Caching stores) | Outward | Why |
| --- | --- | --- | --- |
| `/day`, `/alignment`, `/track`, `/sightline`, `/crossing`, `/position` + `time`, `/magnetic` + `time`, search windows | `public, max-age=31536000, immutable` | same | pure function of the query; CACHE_VERSION is in the key |
| `/weather` | computed in the front door (feed via MetarFeed) | `private, max-age=30` | keys almost never repeat; forwarding paid the tier round trip |
| `/position`, `/magnetic` without `time` | not forwarded | `no-store` / `public, max-age=3600` | max-age=0 forwarding cost +35 ms server p50 with no sequential hits |
| any non-200 from the Api, or no Cache-Control | `no-store` | `no-store` | errors are never cached (`defaultNoStore`) |
| `/` | never forwarded | `private, no-store` | the sky at request.cf's location; the key ignores request.cf |
| `/docs`, `/docs/interactive`, `/llms.txt`, `/openapi.json` | — | `public, max-age=300` | cheap, front door |
| BlockStore blocks and geoid bands | `public, max-age=31536000, immutable` | — | the file hash is in the path; bands sha-checked before serving |
| MetarFeed feed | `public, max-age=60, stale-while-revalidate=600, stale-if-error=86400` | — | upstream regenerates ~1/min; a day of upstream outage still answers |
| Og `/og.png` | render `public, max-age=600`; fallback card `max-age=60` | | see "Link previews" |

**Keys and versions.** Workers Caching keys by entrypoint + path + query (+ ctx.props, + version unless
`crossVersionCache`); not the host, not other headers. `crossVersionCache` is on and Worker-wide (ivar, 2026-10-29), so
answers, blocks and the feed survive deploys; the only partition is **`CACHE_VERSION`** (src/cache-version.ts), carried by
every loopback key. Guardrails:

- `src/loopback.ts` is the only code that fetches our entrypoints; test/loopback.test.ts fails on any other read off
  `ctx.exports`.
- test/golden.test.ts hashes the bodies of a fixed set of deterministic requests into test/golden/answers.json with the
  CACHE_VERSION they were recorded at. Answers changed and CACHE_VERSION did not → fail. After a bump: `npm run
  golden:record` and commit both. Two agents changing answers at once: the second rebases, bumps, re-records.
- A format-only change to blocks, bands or the feed needs a bump too (the golden test doesn't see it). A bump makes every
  entry a MISS once.

**MetarFeed.** Every weather request fetches the feed through the loopback; `cf-cache-status` is the tier. Revalidations
arrive as conditional requests and are passed upstream, so an unchanged feed is a 304 → `REVALIDATED`. Collapsing and SWR
are the cache's (no hand-written single-flight). The parsed table (lazy: id + coordinates indexed, stations decoded on
demand) stays in isolate memory keyed by ETag / Last-Modified, so a version is parsed once per isolate; if the loopback
fails, the isolate's last table answers as `stale-on-error`. Logs: `{"evt":"metar",tier,dataAgeS,bytes,parsed,version,
error,n,nearest,km}` per weather request and `{"evt":"metar.upstream",status,bytes,ms,conditional,version}` per upstream
call (MetarFeed). `metar-cache.py` reads both.

## Subsystems

### Geoid bands (EGM96 from R2)

Every route with an observer needs the EGM96 undulation N (`observer.geoidUndulation` is always in the answer; a missing
`height` puts the observer on the geoid); alignment loads every band within target lat ± maxDistanceKm. The Worker bundles
only the manifest (packages/core/src/egm96-bands.ts: per band offset, length, sha256 prefix) and reads bands from R2:

```
handler ─ geoid.load (concurrent with blocks.load) ─ L1 (isolate Map, ≤ 46 bands) ─▶ loopback.ts geoid
        ─▶ BlockStore GET /geoid/v<CACHE_VERSION>/<sha16>/<band>  (Workers Caching, immutable)  ─▶ R2 ephem-geoid egm96-30/<sha16>.bin
```

46 bands of 8 rows (5.6–6.6 KB); a lookup reads 1, or 2 at a band edge. BlockStore checks length + sha256 before answering
(else 502 `no-store`), the consumer checks again; any failure is a typed 503 naming the band, nothing is cached, and core
throws if a band wasn't prefetched (a wiring bug can never answer a wrong height). Bit-identical to the old bundled grid
(8.28 M lookups, 2026-10-30). Upload: `node --experimental-strip-types scripts/geoid-r2.ts upload` (idempotent), `verify`,
`manifest` after `reference/geoid/make_grid.py`. Bucket `ephem-geoid`; **never** write to `ephem-de440`. Tests use no
network: test-setup.ts installs the source-tree grid (`geoid-bundled.ts`, never imported by the Worker).

### Alignment search (`POST /alignment/search`, src/search.ts)

One POST in the front door → one `GET /internal/alignment-search-window` per 30-day window on a fixed UTC grid, all in
parallel through `loopback.ts api` (cached, immutable, cross-version) → merge, filter, include. The front door answers 404
for the window path from outside; all astronomy CPU is in the window invocations (Api, tier colo). Design: DESIGN §10.x.

| Span | Where | Attributes |
| --- | --- | --- |
| `search` | front door | `ephem.windows`, `ephem.windows_cache` (`HIT:12,MISS:2`), `ephem.passes`, `ephem.passes_total`, `ephem.segments`, `ephem.region_vertices`, `ephem.span_days`, `ephem.search.anomalies` |
| `search.window.fetch` | front door, one per window | `ephem.window`, `ephem.api_cache`, `http.status_code`, `ephem.api_key` (200 chars) |
| `search.window` | Api (a MISS) | as every handler span, plus `geoid.load` |
| `compute.search` | Api | `ephem.passes`, `ephem.region_vertices`, `ephem.search.<counter>`: `scanEvaluations`, `spans`, `spanSeconds`, `trackEvaluations`, `crossings`, `refineEvaluations`, `segments`, `anomalies` (must be 0), `maxSagittaM` |

The response repeats the counters (`search.counters`; a HIT returns the counts of the run that filled it) and
`search.windows[].cache`.

```sh
python3 scripts/obs/cpu-by-version.py --minutes 20 --path /internal/alignment-search-window --entrypoint Api   # per window
python3 scripts/obs/cpu-by-version.py --minutes 20 --path /alignment/search                                   # the merge
python3 scripts/obs/trace.py --latest /alignment/search                                                       # fan-out tree
```

A cold scan needs keys nobody has cached: vary the target height or region by a centimetre (the region is quantised to
1e-7°, so move a vertex by ≥ 2e-7°). Window MISS cost varies ~4× with isolate warmth, not the window (a fresh isolate pays
~100 ms start-up + ~2× CPU; `cold-split.py --route alignment-search-window`).

### MCP (`/mcp`, src/mcp.ts)

Unauthenticated, stateless MCP over Streamable HTTP, in Effect (no SDK). Modern **2026-07-28** (no handshake;
`_meta["io.modelcontextprotocol/protocolVersion"]` + `clientCapabilities` on every request, mirrored in
`MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name`; `server/discover`, `tools/list`, `tools/call`) and legacy
**2025-11-25 / 2025-06-18 / 2025-03-26** (`initialize` negotiates; `ping`; notifications → 202; no session id; no
`MCP-Protocol-Version` header = 2025-03-26, the only version accepting batches). GET/DELETE → 405. Origin: absent or https
passes; http only from loopback or the same host; `null`, `file:`, extension and malformed origins → 403. Tool arguments
decode with the REST query schema and run the router's own route in-process, so schemas come from `@ephem/api` and the math
is the REST path. Both eras must keep working: the probe and Inspector speak legacy, Claude Code speaks 2026-07-28.

```sh
node --experimental-strip-types scripts/obs/mcp-probe.ts https://ephem.ivar.workers.dev   # exit 1 on any FAIL
python3 scripts/obs/trace.py --jsonrpc-id <run>-legacy.call.day                           # one tool call's tree
npx -y @modelcontextprotocol/inspector@2.13.0 --cli https://ephem.ivar.workers.dev/mcp --transport http --method tools/list
```

One `mcp.<method>` span per JSON-RPC message (`mcp.parse_error`, `mcp.invalid`), child of the router's `POST`; a
tools/call span is the parent of the REST handler span. Attributes: `mcp.method`, `jsonrpc.id`, `mcp.protocol_version`,
`mcp.requested_version` (initialize), `mcp.client` (`name/version`), `mcp.tool`, `mcp.rest_status`, `mcp.error_code`,
`mcp.is_error`, `mcp.batch`, `mcp.notification`, `mcp.origin_rejected`, `ephem.api_cache`. Find calls with a raw filter on
`jsonrpc.id`, `mcp.tool` or `mcp.client`; don't count with `$metadata.transactionName = mcp.tools/call` (it returned only
some spans).

### Homepage (`/`, src/home.ts)

- **One round trip.** GET / flushes the head (CSS, markup, boot script) at once, then streams
  `<script type="application/json" id="ephem-position|ephem-track|ephem-day">` with the API's own bodies (run through the
  router in-process, src/embed.ts), then the inline font, then `</body>`. The page boots from the embed and fetches only
  what is missing (and weather). Spans: `home.embed` (`home.embedded`: how many of three), `html.stream` (the streamed
  body's end: last chunk handed to the runtime). Marks `ephem:embedded` or `ephem:fetched`, then `ephem:data`.
- **Debug states:** `/?lat=&lon=&tz=&place=&at=<ISO>[&pose=<az>,<alt>]` freezes the page clock and asks
  `/position?time=` (the embed is ignored). `home-states.ts` shoots every state.
- **The chart draws only on change** (data, resize, theme, drag, pointing, fonts; a once-a-second check whether a live
  marker moved half a pixel). No rAF loop. `window.__sky.draws` counts frames.
- **Chart model (CORE_JS, pure):** `skyModel` (`trackSpan`: one azimuth revolution cut at the seam; `altU`: linear above
  the horizon, 36·tanh(alt/36) below, C2), `layoutLabels`. test/home.test.ts: zero label crossings, one connected track per
  body, no kinks over 13 sky states at 390 and 375.
- **Font:** "Ephem DIN" (D-DIN subset, OFL; src/din.ts generated by scripts/fonts/din.py, byte-reproducible, sha256
  pinned), inline in the streamed tail, licence at /licenses/din.txt. Printable ASCII caps, Latin-1 and Latin Extended-A
  capitals (but Ŋ), Ș Ț, ° · ’ – — − arrows (composed by din.py). Every DIN element is set in caps; the `--din` stack keeps
  system fallbacks per glyph (never tofu).

### Link previews (`/og.png`, src/og.ts)

A shared link previews as a live 2400×1260 card of that place's sky, rendered by **glyph** (glyph.ivar.workers.dev: JSON
scene → PNG) over the `GLYPH` service binding (a public fetch between two `*.ivar.workers.dev` Workers is refused).

- **Scene** (src/og.ts, pure): the homepage chart ported from CORE_JS (test/og.test.ts runs both over the same inputs),
  EPHEM + place, the countdown to the next event, Sun/Moon alt/az. Text is caps (`din()`: NFC + toUpperCase, never folded:
  TROMSØ). glyph refuses a missing glyph, so `faceFor()` picks Ephem DIN, else Noto Sans (pinned by commit + sha256), else
  coordinates; ~50 real place names are tested.
- **A font change is one deploy:** the spec names the font on the rendering version's own preview URL
  (`https://<version id[0:8]>-ephem.ivar.workers.dev/assets/…`), so a canary renders with its own font (needs workers.dev
  preview URLs on).
- **Routes** (front door, no request row): `GET /og.png?lat&lon&place&tz&t`, `GET /assets/<sha16>/ephem-din-*.woff2`, `GET
  /apple-touch-icon.png` (regenerate with `node --experimental-strip-types scripts/og/assets.ts [--glyph-lib <clone>]`).
- **Cache:** the front door normalises (0.01°, 10-minute bucket clamped to [now − 2 d, now + 1 bucket], a valid zone) and
  calls the cached `Og` entrypoint, key `/v<N>/og/png?<query>`. A miss reads the bucket's answers from the Api and POSTs
  the scene to glyph; past `GLYPH_BUDGET_MS` (2.5 s) the static fallback answers (`x-ephem-og: fallback:<why>`,
  `max-age=60`) and the render finishes in waitUntil.
- **Head tags** (src/og-head.ts): og:* / twitter:* with the rounded place and bucket in the image URL; for a preview bot
  the head reads position + day in-process (span `home.og`, ≤ 1.2 s) for a live description.
- **Spans:** `og.front` (`og.outcome`, `og.cache`, `og.ms`, `og.bytes`, `og.t`), `og.render` (`og.data_ms`,
  `og.glyph_ms`, `og.glyph_cache`, `og.bytes`, `og.ms`). Headers `x-ephem-og`, `x-ephem-og-cache`.
- **Look at it:** `curl -o og.png 'https://ephem.ivar.workers.dev/og.png?lat=40.71&lon=-74.01&tz=America%2FNew_York&place=New+York+City'`;
  `sips -Z 300 og.png --out og-300.png` is about how iMessage shows it.

### Rates (altitudeRate, azimuthRate)

One function, `topocentricRates` (packages/core/src/observe.ts), analytic from the DE440 Chebyshev velocity (DESIGN.md
"Rates"); /track reports none. Measured 2026-10-30: 3.6e-7 °/min (alt) and 3.9e-7 (az·cos) vs Richardson(30 s, 60 s) over
200 000 samples, at or below what a difference of these positions can resolve (a JD is one double: instants round to
40 µs). Within 1° of the zenith or nadir the ±2 s difference itself is off by > 1e-5 (cusp), so properties.test.ts checks
nothing there. fast-check prints `{ seed, path }` on failure; `FC_SEED=<seed> npx vitest run
packages/core/test/properties.test.ts` replays it (`CI=1` pins seed 42).

## Current numbers

The latest measurement of each, with its version. Older and superseded numbers: the lab notebook.

| What | Value | Version, run |
| --- | --- | --- |
| deploy, start → 100% / live verdict | 44 s / 108 s after promotion (no wait for a previous watcher) | 802adee1, ship cc53d9b |
| canary telemetry gate (early pass) | 22–30 s | 802adee1, b4694777 |
| homepage, iPhone Fast 3G 4× CPU, cold | TTFB 807, FCP 979, data drawn 1230 ms; 21/21 requests joined; θ 22.2 ± 12.7 ms | b4694777 / ac16823e (mid-deploy), J20261031T044455Z-1xi2 |
| remote load, client p50 (enam + weur) | position 8 ms, warm HIT 11 ms, weather 15 ms, cold track 288 ms, cold scan 238 ms | d489af37, L20261031T045109Z-uqz8 |
| front-door CPU p50 / p99 | `/alignment` 2 / 35, `/day` 2 / 22, `/alignment/search` merge 29 / 39 ms | d489af37, same run |
| search window Api CPU p50 / p90 / p99 | 52 / 100 / 133 ms (n 70) | d489af37 |
| Api, fresh isolate vs warm (`/track`) | CPU p50 43 vs 10–11 ms; pre-router gap p50 92 ms | d489af37 |
| live `/position` wait before the handler | p50 / p99 / max 0 / 15 / 39 ms (n 121) | d489af37 |
| 10 identical cold `/day` | 1 MISS + 9 HIT | d489af37 |
| `/og.png` | MISS 1.3–1.6 s, HIT 0.14 s client; PNG ~166 KB | b4694777 smoke |
| CPU per cold 12-month park scan | 500–519 ms (Σ 14 windows + merge) | 8413211a (2026-10-30) |

## Gotchas

- **`$metadata.id` is not unique**: dedupe by the whole `$metadata` (or ray + type), count rays or trace ids. An id dedup
  silently dropped 5–37 % of events (2026-10-30).
- The o11y query API rate-limits bursts (`429 [971]`) and occasionally 500s (`[10500] Internal authentication error`):
  telemetry.py retries and caps concurrency; `events_all` fails loudly on a lost slice. Run heavy pulls one tool at a time.
- `cf o11y telemetry query` rejects fractional timeframe bounds; `--parameters-filters` flags are rejected (use `--body`).
- Workers Observability splits JSON log keys on ".": log label/count pairs as strings ("- /llms.txt 1"), not object keys.
- Console JSON lines have no `$metadata.level`; `console.error` lines have level `error`.
- Ingest lags: right after a load run invocation counts are short (196 of 240 at +60 s, all at +5 min). Wait before final
  numbers.
- **A client that disconnects mid-request to `/mcp` logs `Network connection lost.` at level error, and the live gate
  rolls back on it** (a crashed mcp-probe rolled back ac16823e, git f32d46b, 2026-10-31). Don't run a broken probe against
  prod during a live window.
- Invocation `wallTimeMs` includes waitUntil (the ~1 s Basin send): compare wall only between versions with the same
  `REQUEST_LOGS`.
- The tracing API's `setStatus` takes `{ code: "ok" | "error" }`, not a string (a string threw in prod: ~2 min of 500s);
  every tracing call goes through `safe()` in src/trace.ts.
- `wrangler.config.ts` (used by cf) spells build options in camelCase (`keepNames: false`; esbuild's default `__name`
  wrapping once took 21 % of CPU). `wrangler deploy --dry-run` reads wrangler.jsonc instead: verify bundles with
  `cf deploy --dry-run`.
- `cf` on a Request copy is dropped in Node: the front door passes `cf` in fetch's second argument.
- A cache-enabled entrypoint's response without Cache-Control is cached heuristically (a router 404 was HIT for 3 min):
  the Api sets `no-store` on anything without one.
- **`curl … | grep -q …` under `set -o pipefail` is a false failure** (grep exits at the match, curl gets EPIPE, exit 23;
  29 of 100 healthy /docs). Write bodies to files and grep those.
- Re-deploying an older rev is a rollback of whatever is live (it once replaced another agent's fresh deploy for ~2 min):
  check `cf workers deployments list` first.
- `npm install` in the shared tree removes the per-package `node_modules/wrangler` symlinks cf needs. Restore with
  `ln -sfn "$PWD/node_modules/wrangler" packages/<p>/node_modules/wrangler` (worker, tail, load).
- A pipeline binding for a new stream once failed a version upload with `[10021] Pipeline binding error` (transient).
- `/day` needs `tz`; `/track` rejects a start/end off the stepSeconds grid (snap on the client so keys are shared). The
  homepage's live poll sends no `time` (with one it would leave a single-use immutable entry).
- The default handler's TailItem has no `entrypoint` (ephem-tail labels it `-`).
