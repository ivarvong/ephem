# Telemetry and profiling

How to see what prod ephem is doing: traces, per-version CPU numbers, and CPU/heap profiles. Every command here has been
run against prod. **Keep this file current:** when a command, flag, span, attribute or gotcha changes, update it in the
same change, and add the date to "Last verified".

Last verified: 2026-10-31 (unified client+server traces + RUM: ephem 2abe54b3, git b8746cc; cold search windows: 21250fb5 → 7708ca81 → 8413211a, git a7eb737 / cdf06b0; remote load: ephem-load 8d0730a7 against ephem 8413211a, run L20261030T224759Z-kcfr; compute split A/B: S 02dd1270 + ephem-compute fca6e275 vs E cc6ddd8e, git 5edf1b7, → one Worker ephem d3caf38f, git 7a125fd; compute split: ephem 121b7984 + ephem-compute bb0a1127, git 01e0323; version 4e7c34ee; crossing span + MCP probe b49a8a02; MCP section 68c58ae5; Caching section c72a360c; cold-split, LOAD=track and isolate warmth fbdb337e; geoid bands + bundle A/B 5c337183 / 164e1cd7 / 61305294).

## The loop

instrument → gate green → commit → deploy (`scripts/deploy.sh main "…"`: gate in a clean worktree, 0% canary smoke, promote, live smoke, auto-rollback; see "Deploys") → drive uncached load →
**measure by exact version** (`cpu-by-version.py`, `trace.py`, `profile.sh`) → fix the biggest measured bucket → repeat.
Every number you report carries its version id (and trace id or profile file). Log runs in
`~/code/lab_notebook/ephem-deploy-2026-10-28.md`.

## Tools (`scripts/obs/`)

| Tool | What it gives you |
| --- | --- |
| `python3 scripts/obs/cpu-by-version.py [--minutes 30] [--path /v1/alignment] [--version 80f5b087] [--entrypoint Api] [--from ISO --to ISO]` | CPU and wall p50/p90/p99 and the CPU sum per (version, entrypoint, path, status) from invocation events; entrypoint is `default` (front door), `Api`, `BlockStore` or `MetarFeed`, all in `ephem` (in `--service ephem-compute` only 2026-10-30 19:44Z – 21:37Z: "Compute split"). Every obs script takes `--service` (or `EPHEM_SERVICE`). The A/B tool. `--path` is sent as a server-side filter; `--from/--to` pin an absolute window and read it in full (`telemetry.events_all`: parallel slices, split at the 1000-row cap); `--json` writes one row per invocation. Wall includes waitUntil: see "Request logs (Basin)". |
| `python3 scripts/obs/basin.py status\|failures\|provision\|sql <name>\|crosscheck\|types` | Basin request logs: resources, `basin_send_failed` counts, sink/pipeline provisioning, canned Basin SQL, Basin-vs-o11y counts. See "Request logs (Basin)". |
| `python3 scripts/obs/trace.py <traceId>` or `--latest /v1/day` | One request: invocation CPU/wall, the Effect span tree with work counts, and the runtime's own spans (fetch, jsRpc, R2). The front door and the Api invocation it called are two traces sharing one cf-ray (the Api's ends in its colo, e.g. `-IAD`). |
| `scripts/obs/profile.sh <full-version-uuid> [cpu\|heap] [ms]` | Drives uncached load, captures a prod profile of that exact version, symbolizes it, prints the top. Files land in `profiles/` (gitignored). |
| `scripts/obs/load.sh [rounds] [base]` | Laptop load (prefer `load-remote.ts` for anything you will compare): uncached: per round, one 24 h Moon alignment and one `/v1/day`, each with a fresh window or place so the Api cache misses. `LOAD=weather` instead sends 4 `/v1/weather` requests per round (random land-weighted lat/lons, n = 1–3), ~16 req/s. `LOAD=track`: 2 homepage-shaped `/v1/track` per round (72 h from a UTC midnight, 20-min grid, 217 samples) at fresh lat/lons, ~8 req/s; also works under `profile.sh`. `LOAD=search`: one cold 12-month Brooklyn Bridge Park `POST /v1/alignment/search` per round (fresh target height: 14 never-seen windows), ~2/s (`SEARCH_SLEEP`); works under `profile.sh`. |
| `python3 scripts/obs/queue.py --from ISO --to ISO [--path /v1/position] [--over 20] [--version id] [--json out]` | Server-side wait before the handler ran, per request: Effect request span start − runtime request span start. Lists the requests that waited, each tagged **new isolate** (blocks/geoid not yet in L1: start-up) or **busy isolate** (L1 warm: stuck behind other JS), with CPU and `ephem.isolate_computes`. Use it instead of client p99 for "did X slow Y down" (see "Position tail under scan load"). `--path /v1/alignment/search/window` for Api windows. `--json`: one row per request (wait, cpu, isolate_computes, kind, version, ray). |
| `python3 scripts/obs/cold-split.py --from ISO --to ISO [--route track] [--json out.json]` | Api CPU by isolate warmth: each Api invocation of the route joined to its handler span's `ephem.isolate_computes` (1 = the isolate's first computation), p50/p90/p99 and CPU sum per bucket, and the runtime-GET → Effect-GET gap (isolate start-up before the router). Versions before the attribute fall back to "L1 empty" as the cold proxy. |
| `python3 scripts/obs/metar-cache.py [--minutes 30] [--version 80f5b087] [--slice 2]` | METAR feed cache: per (version, tier) request count, share, wall and CPU p50/p99, parses, data age; upstream calls (MetarFeed's `{"evt":"metar.upstream"}`) by status, conditional, and per minute. Joins each `{"evt":"metar"}` log line to its invocation on `$metadata.requestId`. |
| `python3 scripts/obs/cache-probe.py [base] --mode repeat\|unique\|burst [--keys 10] [--repeats 5] [--burst 50] [--routes day,…]` | Client-side cross-check of Workers Caching: per request `x-ephem-cache` (the Api's cf-cache-status relayed by the front door), client and server-timing latency; p50/p99 by (route, status). `burst` fires N concurrent identical cold requests (collapsing test); count Api invocations for that key with a `starts_with` filter on `$workers.event.request.url = https://api.internal/<path>?<sorted query>`. |
| `node --experimental-strip-types scripts/obs/load-remote.ts --mode mixed --rate 60 --duration 60 --regions enam,weur,apac [--pin ephem=<id>]` | **Remote load** from the `ephem-load` Worker's Generator Durable Objects (packages/load): open-loop, per region, client p50/p90/p99 per (region, kind), answering colos, cache and version mix, drops. Prints the run id and the measured window; writes `load-runs/<run>.json`. See "Remote load". |
| `python3 scripts/obs/load-check.py load-runs/<run>.json [--json out]` | Server side of a remote-load run: front-door invocations with `x-ephem-load: <run>` per (route, colo, status, version) against the client's count, and client vs server e2e on the same requests (joined on cf-ray). See "Remote load". |
| `node --experimental-strip-types scripts/obs/mcp-probe.ts [base]` | Full MCP client session against `/mcp` (legacy handshake + modern 2026-07-28 flow + error cases); every tool call (8 tools, incl. `crossing` and `sight_line`; the alignment call uses heightRef/targetHeightRef=msl, aim=litCentroid, include=sun,phase) is checked equal to its REST endpoint (the POST tool `alignment_search` against its REST POST), plus the REST 400 UnknownParameter and a null `apparentAltitude` case. Pass/fail table with latency and cf-ray. Run after every deploy. |
| `scripts/smoke.sh <base> [--pin <version>] [--expect <version>] [--expect-compute <id>] [--only a,b]` | Every route + content checks + the MCP probe; `--pin` sends `Cloudflare-Workers-Version-Overrides` and requires `x-ephem-version` = that version on every response (the probe too, via `EPHEM_VERSION`). The `compute` / `compute-hit` checks send a never-seen position+time key and require a MISS computed by the Api (`x-ephem-compute-version`, = `--expect-compute` if given; deploy.sh passes the version under test, since a loopback runs the caller's version), then HIT. deploy.sh runs the deployed commit's copy. See "Deploys". |
| `python3 scripts/obs/canary-gate.py <worker> <new> <prev> --since ISO --run ID --manifest FILE [--live 90]` | deploy.sh's telemetry gate: the smoke's requests (by `x-ephem-smoke`, cf-rays) in o11y; fails on exceptions, 5xx, error logs, missing entrypoints/spans or telemetry; CPU vs previous as warnings. See "Telemetry gate". |
| `python3 scripts/obs/tail-check.py [--minutes 10] [--version <id>] [--wait 90] [--require /v1/track,…]` | ephem-tail from its own o11y events (no Basin token needed): invocations by (version, outcome), `basin_send_failed` lines, and the route labels summed from its `tail_batch` log lines. Exit 1 on a non-ok outcome, a send failure or a missing required label. deploy.sh runs it after a tail deploy. |
| `python3 scripts/obs/trace.py --jsonrpc-id <id>` | The trace of one MCP message (the probe's ids are `<run>-<step>`). |
| `node --experimental-strip-types scripts/obs/journey.ts <url> [--device iphone\|desktop] [--net fast3g\|4g\|none] [--cpu 4] [--cold\|--warm] [--script home-drag\|none] [--duration 70] [--out dir]` | **Unified client+server trace** of one page view, driven by our CDP client (scripts/obs/cdp/): Chrome timeline + network, every request joined to its invocations and spans, clock offset, the page's own RUM checked against Chrome. Single-file viewer + Perfetto JSON. `--rebuild <name>.raw.json` after a model/viewer change. See "Unified client+server traces". |
| `node --experimental-strip-types scripts/obs/trace-view.ts <trace-id>\|--latest [--real]` | A real page view rebuilt from production RUM (Basin `ephem.rum`), `ephem.requests_v2` and o11y by trace id; same viewer. |
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

## Deploys (`scripts/deploy.sh`)

`scripts/deploy.sh <rev> "<message>" [auto|ephem|tail|load|all]` (`DRY=1`: gate only). Lock, never-backwards guard
(`ALLOW_OLDER=1` to roll back on purpose), clean worktree of `<rev>`, full gate, then:

1. **ephem-tail** first when targeted (`auto`: packages/tail, packages/worker/src/routes.ts or the invocations schema
   changed since the last `deployed-tail/` tag, or `tailConsumers` changed): `cf deploy`. After ephem's smoke has sent it
   traffic, `scripts/obs/tail-check.py --version <new> --require <the smoke's routes>` must pass, else ephem-tail is routed
   back to its previous version. Tag `deployed-tail/<ts>`.
2. **ephem-load** when targeted (`load`, `all`, or `auto` when packages/load changed since the last `deployed-load/` tag):
   `cf deploy` (a whole deploy: it has Durable Objects and serves no users), wait for 5 `/health` answers from the new
   version, then: `/health` names the fixed target and the limits; POST /run without the token is refused (401); with the
   token an over-limit `/plan` is refused (400) and a 10-request run from enam completes through `load-remote.ts`. Any
   failure routes ephem-load back to its previous version. If the Worker has no `LOAD_TOKEN` yet (first deploy), it runs
   `scripts/obs/load-token.sh` first. Tag `deployed-load/<ts>`. (The `compute` target was removed 2026-10-30; "Compute split".)
3. **ephem, gradual**: record the version at 100% (`cf workers deployments list`; a split deployment aborts), `cf workers
   versions create`, `cf workers deployments create` with new 0% + previous 100%, wait until 5 pinned `/healthz` in a row
   come from the new version, then `smoke.sh --pin <new>`, then the **telemetry gate** ("Telemetry gate" below). Prod
   traffic never sees the canary. Either fails → remove it (100% previous), exit 1, no tag.
4. Promote (new 100%), wait until 5 unpinned `/healthz` in a row carry the new `x-ephem-version` (not a fixed sleep), then
   `smoke.sh --expect <new>`, then the gate in live mode (the live smoke + 90 s of real traffic). Failed checks are retried once (only those, after `RETRY_S`=5 s). Still failing → route 100%
   back to the recorded version, wait until it serves, re-smoke it with the last deployed commit's smoke.sh, exit 1, no tag.
5. A diff touching non-versioned settings (`tailConsumers`, `observability`, `logpush` in cloudflare.config.ts; `GRADUAL=0`
   forces it) skips the 0% stage and uses `cf deploy`: `versions create` says those apply only on the next deployment.
   Steps 3's live smoke and rollback still apply; a rollback restores code, not those settings.

**Why it is trustworthy** (2026-10-30): version overrides ([docs](https://developers.cloudflare.com/workers/versions-and-deployments/version-overrides/))
apply to versions in the current deployment, including at 0%; the front door sets `x-ephem-version` from the
VERSION binding, and smoke.sh fails any response from another version. The pinned front door's `ctx.exports` loopbacks run
the pinned version too: in the canary window of 37d28e99 (18:53:21.8–18:53:33.8Z) all Api (5) and MetarFeed (1)
invocations were 37d28e99, the 3 front-door invocations on 0d870218 were other traffic. A 0% version is reachable
pinned 3.0–3.7 s after the deployment (n=3); a promoted one serves 5/5 unpinned 2.7–6.2 s after (n=3), so the old
`sleep 5` was not a guarantee.

**Rollback, measured** (throwaway detached commit 8f6bb15 whose smoke checks a nonexistent route in the live phase only;
never on main): canary smoke 18/18 pinned → promote → `deploy-canary` 404, retried after 5 s, 404 → rollback.

| run | new version | promote → rollback deployment | rollback deployment → previous (37d28e99) serves 5/5 | decision → restored | new version at 100% |
| --- | --- | --- | --- | --- | --- |
| 1 | 5679099c | 18:56:22.7 → 18:56:42.1Z | 5.3 s | 6.9 s | ~25 s |
| 2 | 2b0a5695 | 18:58:03.4 → 18:58:20.8Z | 3.9 s | 5.5 s | ~21 s |

Restoration is < 10 s from the decision; the rest is the live smoke (~7 s) and the 5 s retry. Both exited 1 untagged and
re-smoked 37d28e99 18/18 (run 2; run 1 re-smoked with the failed commit's own smoke, fixed in cb07493).

### Telemetry gate (`scripts/obs/canary-gate.py`, 2026-10-30)

The smoke only sees what a client sees. The gate reads Workers Observability for the same requests before promotion
(ivar: "use a 0% version … hit it with that version, run the full smoketest, via the o11y with cf cli, before progressing").

- **Selection.** deploy.sh runs every smoke with `--run <id>` (header `x-ephem-smoke: <id>` on every curl check and every
  MCP probe request) and `--manifest <file>` (one line per request: `<cf-ray> <status> <method> <path> <check>`). The gate
  queries front-door invocations by that header (live traffic can't pollute it), joins Api invocations by their request
  header `x-ephem-ray` (= the front ray), BlockStore invocations by rayId prefix, then pulls every span and log line of
  those traces with a `$metadata.traceId` `in` filter (comma-joined values; a JSON array is rejected). At 0% it also reads
  every invocation and log of the new version id in the window (only pinned requests reach it).
- **Two records per request.** The invocation event and the runtime's root span (`cloudflare.ray_id`, `outcome`,
  `http.response.status_code`, `cpu_time_ms`, version) are ingested independently. A request is visible if either
  arrived: in the first pinned run one invocation event (`/assets/…/RPNDot-Regular.woff2`, ray a52d5c29ef834350) never
  arrived while its root span did (1 of 154 smoke requests over two runs).
- **Ingest wait.** Polls every 5 s up to `--wait 90`; stops early once 100% of the manifest is visible and every required
  span is present. At the deadline: coverage ≥ 95% of the smoke's requests, every smoke check with at least one visible
  request, and every required entrypoint/span, else FAIL (missing telemetry never passes). Measured: see the table below.
- **FAIL:** outcome ≠ ok; any 5xx (invocation or root span) or a server status that differs from the client's; any log
  at level error, any key ending `_failed` (`basin_send_failed`, `request_log_failed`), any `{"evt":"*_failed"}`; a smoke
  request answered by another version of the Worker under test; missing `GET`/`POST`/`api.fetch` spans (default),
  `mcp.initialize` + `mcp.tools/call` (MCP), an Api invocation with `position` + `blocks.load` spans, a BlockStore
  invocation when an Api `blocks.load` span reports a MISS (smoke check `blocks-miss` asks for a random instant in
  1972–2149 to force one), and any linked Api / BlockStore invocation on another version (a loopback runs the caller's version).
- **WARN only: CPU.** Per (entrypoint, path): new p50 > 2× the previous version's p50 (last 15 min) and +5 ms, or new max >
  previous p99 + 50 ms, when the baseline has n ≥ 10. Not a failure rule: the smoke sends 1–3 requests per route to fresh
  isolates whose first request pays start-up (cold-split.py: 1.2–2× CPU), and no threshold separates that from a
  regression at that n.
- **Live (after promotion, `--live 90`).** The live smoke's requests as above, plus every invocation and log of the new
  version in [promotion, +90 s] (waits until +105 s for ingest). An error on real traffic fails only if its signature
  (service, entrypoint, kind, path) did not occur on the previous version in its last 15 min; a pre-existing signature or
  a user's `canceled` is a warning. Failure → the existing rollback path.
- **Deterministic half: `x-ephem-errors`.** The front door counts `console.error` lines (every `*_failed` log, the
  tracing `safe()` warning) and unhandled rejections per isolate and returns the count on responses to requests carrying
  `x-ephem-smoke` (src/index.ts). A pinned canary's isolates serve only the smoke, so `smoke.sh --pin --run` and the MCP
  probe (`isolate.errors` row) fail on any non-zero count with no ingest dependency. An error in waitUntil after a response
  shows on that isolate's next request. Not available for the Api: its responses are cached by Workers Caching, so a
  header there would be replayed; Api errors are telemetry-only.
- `SKIP_O11Y_GATE=1` skips both gates (emergencies only; deploy.sh prints a banner). `O11Y_WAIT_S`, `O11Y_LIVE_S`
  override 90 / 90. A commit from before the gate runs its own deploy.sh (below), which has no gate.

**Measured** (logs: scratchpad `o11y-gate/deploy-*.log`):

| run | version | what | ingest / gate time | result |
| --- | --- | --- | --- | --- |
| (a) canary, git 5026667 | 639e952a | 77 smoke requests (23 checks + 54 MCP-probe requests) | 0/77 visible at 6 s, 77/77 at 57 s (3 polls); gate 59.7 s | GATE ok, 0 errors, 0 warnings; Api ×8, BlockStore ×1 (forced MISS); every span |
| (a) live, same | 639e952a | live smoke + 90 s real traffic (111 events on the version) | 77/77 at 67 s; gate 101.9 s (waits to promotion + 105 s) | GATE ok |
| (a) canary, git 0af943a (two-stage deploy.sh) | 21250fb5 | 77 smoke requests | 77/77 at 37 s; canary gate 39.7 s, live gate 95.5 s | GATE ok both |
| (c) throwaway 7e170687 (never on main): marker in its inner deploy.sh + the same log line | c0e1fb57 | client smoke 23/23 ok; bootstrap printed sha256 35778f5c (commit) vs b9ba0842 (shared tree) and the marker | 52/77 visible at 25 s, error found; gate exit 1 after 27.6 s | canary 0% 21:46:42.9Z → removed 21:47:27.4Z (removal 1.7 s); prod stayed 21250fb5; lock + worktree released |
| (b) throwaway df22873a (never on main): `console.log({"evt":"gate_test_failed"})` on /v1/magnetic, answers unchanged | b9e54fef | client smoke 23/23 ok (pinned) | the log line was visible at the first poll (5 s), before any invocation event; gate exit 1 after 7.6 s | canary 0% 21:36:09.6Z → removed 21:36:28.9Z (19.3 s at 0%, removal 1.5 s after the decision); prod stayed on 639e952a; exit 1, untagged |

Log lines ingest faster than invocation events (seconds vs ~30–60 s), so a logged error fails the gate early; a clean
canary costs ~60 s of waiting for the invocations. The CPU columns of (a) show why CPU is a warning: the Api's first
`/v1/position` on a fresh isolate was 80 ms against p50 35.

### Two-stage deploy.sh (bootstrap, 2026-10-30)

deploy.sh runs from the shared tree, so an agent's uncommitted deploy.sh ran another agent's deploy (2026-10-30, 21:33Z: the
compute-split revert's in-progress deploy.sh smoked commit 5026667 with the wrong compute expectation; the canary failed
closed). Now the shared-tree copy is only a **bootstrap**: lock, never-backwards against the last `deployed/` tag,
`git worktree add <rev>`, then `exec <worktree>/scripts/deploy.sh` with `EPHEM_DEPLOY_INNER=1`, `EPHEM_DEPLOY_LOCK`,
`EPHEM_DEPLOY_WT`. exec keeps the pid, so the lock's owner line stays true; the inner copy checks it, owns the EXIT trap
(lock released, worktree removed on every path) and runs everything else from `<rev>`: node_modules links, gate, deploy,
smoke.sh, canary-gate.py, rollback. A `<rev>` whose deploy.sh predates this (no `EPHEM_DEPLOY_INNER`) runs that deploy.sh
whole (it takes the lock itself). The first line of every deploy names both scripts' sha256. Changing deploy.sh's
inner part needs no care for in-flight deploys; change the bootstrap by `mv`ing a new file in.

```sh
python3 scripts/obs/canary-gate.py ephem <new> <prev> --since <iso> --run <id> --manifest <file> [--live 90] [--json out]
```


## Remote load (`ephem-load`, packages/load, 2026-10-30)

Load from inside Cloudflare, in several regions at once, so an A/B no longer rides one laptop's EWR link (client p99
from the laptop ranged 84–525 ms on idle phases; "Gotchas"). The pattern is db-load's (`~/code/db/bench/worker`).

```
node --experimental-strip-types scripts/obs/load-remote.ts --mode mixed --rate 60 --duration 60 --regions enam,weur,apac
     [--pin ephem=<version id>] [--warmup 10] [--seed 1] [--mix position=40,warm=30,track=15,weather=14,search=1] [--shards N] [--plan]
python3 scripts/obs/load-check.py load-runs/<run>.json            # >= 5 min after the end (ingest lag)
```

**How it works.** `POST /run` on `https://ephem-load.ivar.workers.dev` (Bearer `LOAD_TOKEN`) validates the spec, asks
the **Coordinator** DO (one object) to admit it, then starts `shards` **Generator** DOs per region, each created with a
location hint (`<run>:<region>:<shard>`; a hint applies only at creation, so every run gets new objects). Every shard
starts its open-loop schedule at the same instant (8 s after the POST; the warm keys are prewarmed before it), sends
arrival *i* at `start + (i + shard/shards)/rate`, never waits for answers, and drops (counts) an arrival that finds 6
requests in flight rather than queueing it. The first `--warmup` seconds (default 10) run the same schedule and are
counted apart. Each shard records per kind: a 1 % log histogram of client ms (fetch → last body byte), statuses, errors,
`x-ephem-cache`, `x-ephem-version`, the answering colo (cf-ray suffix) and a 150-request reservoir of `[ray, ms, status,
t]`. `GET /run/:id` merges shards into regions and regions into totals. Ctrl-C sends `POST /run/:id/stop`.

| mode | requests (the laptop harness it matches) |
| --- | --- |
| `position` | `GET /v1/position?lat=40.7&lon=-74` (live, front door; split-ab's probe) |
| `warm` | the 24 split-ab warm keys (day / track / alignment, Nov 1–8), prewarmed by every shard: HITs |
| `track` | homepage-shaped `/v1/track` (72 h from a UTC midnight) at a fresh lat/lon (load.sh `LOAD=track`) |
| `weather` | `/v1/weather` at a random land-weighted lat/lon, n = 1–3 (load.sh `LOAD=weather`) |
| `search` | `POST /v1/alignment/search`, 12-month Brooklyn Bridge Park scan at a fresh target height (split-ab's cold scan) |
| `mixed` | position 40, warm 30, track 15, weather 14, search 1 (weights; `--mix` to change) |

Cold keys come from a PRNG seeded by the run id and the shard, so they are new in every run. A rerun with the same seed
and plan used to re-send the last run's keys; they came back as HITs (L20261030T224511Z-iqf9: track 71 % HIT, scan p50 70 ms
against 318 ms). `--seed` drives only the schedule and the kind picks.

**Tagging.** Every request carries `x-ephem-load: <run>` and `user-agent: ephem-load/1 (run <run>)`. In o11y, filter
`$workers.event.request.headers.x-ephem-load = <run>`. Request rows have `ua_family = 'synthetic'` ("Request logs"). The
canary gate's live phase still counts load traffic as traffic (an error under load is an error).

**Safety limits** (packages/load/src/workload.ts `LIMITS`, enforced by the Worker; test/workload.test.ts):
one target, `https://ephem.ivar.workers.dev`. The spec has no host, path or header field, an unknown field is refused, and
every URL is checked against it. The colo probe is ephem's own `/cdn-cgi/trace`. Pins must be a full version uuid. Total
rate ≤ 300 req/s, ≤ 64 req/s per region, scans ≤ 4/s (240/min), duration ≤ 600 s, warmup ≤ 60 s, ≤ 60 000 requests per
run, ≤ 150 000 per rolling hour, ≤ 5 regions. One run at a time (the CLI releases the lock when its run is done), 6 in
flight per shard, and timeouts of 10 s (30 s for scans). Without the `LOAD_TOKEN` secret every call but `/health` gets 503.
The token is in `~/.config/ephem-load/token` (0600). `scripts/obs/load-token.sh` creates it and stores the secret from a
0600 temp file. It is never printed.

**One Generator drives ~6.5 req/s** (2026-10-30, position only, one shard in enam). At 3/s: p50 11 ms, p99 220 ms. At
8/s: 6.3/s answered, p50 507 ms, 34 drops. At 15/s: 6.7/s answered, p50 859 ms, 167 drops. Past that, the fetches queue
inside the object. The same 15 req/s over 4 shards: p50 8 ms, p99 21 ms, 0 drops (L20261030T223104Z-nejb). So the plan
puts at most 4 req/s on a shard (`shardRate`; scans 1.5/s), up to 16 shards per region. db-load's 22/s per DO went to a
custom domain. ephem-load needs `global_fetch_strictly_public`, because a Worker's fetch to a workers.dev Worker on the
same subdomain is otherwise refused, so its requests leave through the public front door like an eyeball's.

**Validation** (2026-10-30, ephem 8413211a, ephem-load 8d0730a7, git 7a1e120; run L20261030T224759Z-kcfr, mixed,
60 req/s, 60 s + 10 s warmup, enam/weur/apac, 5 shards each, measured 22:48:17.9–22:49:17.9Z). Client (all requests) vs
server (ephem's runtime request span start → Effect request span end, same requests joined on cf-ray):

| region | generators in | answered in | kind | n | client p50 / p90 / p99 ms | server e2e p50 / p90 / p99 ms | client − server p50 / p90 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| enam | EWR 3, IAD 2 | EWR 303, IAD 183 | position | 486 | 7 / 12 / 755 | 0 / 0 / 3 | 7 / 11 |
| enam | | | track (cold) | 151 | 42 / 114 / 886 | 33 / 61 / 179 | 8 / 13 |
| enam | | | search (cold) | 19 | 296 / 502 / 1082 | 261 / 388 / 466 | 19 / 167 |
| weur | MRS 2, CDG 2, MAD 1 | CDG 216, MRS 194, MAD 103 | position | 513 | 7 / 69 / 810 | 0 / 0 / 4 | 7 / 61 |
| weur | | | track (cold) | 171 | 57 / 99 / 940 | 44 / 66 / 91 | 9 / 35 |
| apac | NRT 3, HKG 1, SIN 1 | NRT 295, HKG 96, SIN 89 | position | 480 | 6 / 92 / 931 | 0 / 0 / 2 | 6 / 92 |
| apac | | | track (cold) | 185 | 38 / 415 / 1091 | 26 / 54 / 630 | 7 / 208 |

- **Counts agree.** 3600/3600 answered (all 200, 0 drops, 0 late arrivals, every answer from 8413211a). o11y has 4550
  front-door invocations with the run's header for 4560 sent (prewarm 360 + warmup 600 + 3600: 99.8 %). Basin has 4563
  `synthetic` rows. Earlier run L20261030T223528Z-7lbt: o11y 3950 = sent 3950, Basin 3950.
- **Latency agrees where ephem is.** For 3591 joined requests, client − server per request is 6–9 ms at p50 for every region
  and every kind except scans (19–32 ms for the scan POST), and never negative (0 requests > 2 ms under the server). `queue.py --path /v1/position --version 8413211a`
  over the window: wait p50/p90/p99/max 0/0/3/165 ms (n = 1488; one new isolate). `cpu-by-version.py`: front-door CPU
  p50 2 ms, p99 7–8 ms (position, track, day), 22 (weather), 42 (scan POST).
- **Colos follow the region.** The location hint picks a region, not a colo: enam ran in EWR, IAD, ATL or MIA in
  different runs, weur in LHR, LIS, AMS, CDG, MRS or MAD, apac in NRT, HKG, SIN or KIX. In kcfr every request was
  answered in its own generator's colo (EWR 720 = 3 shards × 240, IAD 480; MRS 480, CDG 480, MAD 240; NRT 720, HKG 240,
  SIN 240; cf-ray suffix = o11y `cf.colo`).
- **The p99s in this run are not ephem.** 288 of the 3591 requests spent > 200 ms outside ephem's spans. All of them fell
  in seconds 35–45 of the run, in all three regions at once (load-check part 3), while ephem's e2e for the same requests
  stayed small. The run before it (L20261030T224511Z-iqf9, same spec) had no such episode: position p99 20 / 15 / 33 ms
  (enam / weur / apac). Client − server covers the generator, egress and the edge before ephem's isolate gets the request,
  so **compare arms run at the same time** (pin both with `--pin` and run them together, or interleave runs) and use
  `load-check.py` to split any tail into ephem and not-ephem. The first validation run (7lbt, no warmup) put 52 of its 71
  > 200 ms outliers in the first 5 s (new connections). That is why the warmup is there.

**A/B with it.** Use one run per arm with `--pin ephem=<id>` (both versions in the deployment, as in "Compute split"),
started back to back or interleaved, the same `--seed`, and the same regions. The arms' cold keys differ (run id) but
are drawn from the same distribution. Check `pin misses` = 0 in the table. Read server numbers with
`cpu-by-version.py --version` and `queue.py --version` over each run's measured window.

## Caching (Workers Caching; never the Cache API)

No `caches.default` anywhere (`grep -rn "caches\." packages/worker/src` is empty). Caching is Workers Caching in front of
the entrypoints whose `exports` entry enables it (`cloudflare.config.ts`), driven only by the Cache-Control they return.

```
ephem (one Worker; ephem-compute 2026-10-30 19:44Z – 21:37Z, "Compute split")
eyeball ─▶ default (cache OFF: always runs → every request has its trace, Basin row, request.cf; `/` and `/mcp` live here)
             ├─ GET /v1/day, /v1/alignment, /v1/track, /v1/sightline, /v1/crossing, /v1/position|magnetic with time, search windows
             │     ─▶ loopback.ts api: ctx.exports.Api.fetch(path + sorted query, { cf: { cacheKey: "/v<CACHE_VERSION>" + path + query } })
             │        ─▶ Api (cache ON) ─▶ blocks: loopback.ts block  GET /block/v<N>/<sha16>/<i>  (ctx.exports.BlockStore, cache ON) ─▶ R2
             │                                             └▶ geoid:  loopback.ts geoid  GET /geoid/v<N>/<sha16>/<band> (ctx.exports.BlockStore, cache ON) ─▶ R2 ephem-geoid
             ├─ live (position / magnetic without time): computed here; blocks / geoid via ctx.exports.BlockStore (cache ON)
             └─ /v1/weather: computed here; feed via loopback.ts feed GET /feed/v<N>/metars.cache.csv.gz (ctx.exports.MetarFeed, cache ON) ─▶ aviationweather.gov
```

Verified live on every deploy by smoke.sh's `compute` / `compute-hit` checks (fresh key → `x-ephem-cache: MISS`,
`x-ephem-compute-version` = the version under test; same key → `HIT`). While Api + BlockStore lived in ephem-compute
(2026-10-30), the callee's Workers Caching applied across the service binding exactly as over ctx.exports (30/30 MISS →
30/30 HIT, 19:57:06–19:57:46Z, 121b7984); a cache belongs to a Worker, so moving them emptied and refilled it each way.

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

## Compute split (ephem-compute, 2026-10-30: tried, measured, removed)

**Concurrent A/B, then removed** (2026-10-30; Ivar: "We need data."). Pre-registered rule (lab notebook, 20:45Z): keep S only
if a primary metric improves with a 95 % CI excluding 0 and no other primary metric regresses with a CI excluding 0.
Method: one commit (git 5edf1b7) as two `ephem` versions in one 50/50 deployment (`deploy.sh … ab`, since removed): **S** =
02dd1270 (service bindings → ephem-compute fca6e275), **E** = cc6ddd8e (`--mode entrypoint`: Api + BlockStore as ephem's
own cache-enabled entrypoints over ctx.exports). Same keys; separate caches (warm keys pre-warmed in each arm, cold keys
fresh). Laptop EWR client (scratchpad `ab-split/bin/load.ts`) pinned each arm with the version override and fired both
arms' identical open-loop schedules at the same instants (arm order alternating): 124 cold 12-month Brooklyn Bridge Park
scans/min (fresh target height, 14 × MISS), `/v1/position` every 200 ms, a pre-warmed day/track/alignment HIT every 400 ms.
60 s warmup (discarded), 6 runs × 240 s with 60 s gaps, 20:42:57–21:11:57Z; 0 client errors. Server-side rows per run and
arm: queue.py (`--json`), cold-split.py (`--route alignment/search/window`), cpu-by-version.py (`--json`), plus the POST and
`api.fetch` spans (`ab-split/bin/pull.py`); ~495 scans, ~6 920 windows, ~1 220 position probes, ~600 warm hops per run and
arm, matching the client's counts. CI: paired hierarchical bootstrap (resample runs, then rows within run × arm), 2 000
draws (`ab-split/bin/stats.py`, `runs/ab1.stats.txt`).

| primary metric | S (binding) | E (ctx.exports) | S − E [95 % CI] | runs S / E |
| --- | --- | --- | --- | --- |
| position probes waiting > 20 ms before the handler | 0.01 % (1 / 7 324) | 0.03 % (2 / 7 337) | −0.01 pp [−0.10, +0.05] | 0–0.08 / 0–0.16 % |
| position wait p99 | 0 ms | 0 ms | 0 [0, 0] | |
| cold scan e2e p50 / p90 (server: runtime POST start → Effect POST end) | 307 / 464 ms | 336 / 512 ms | **−29 [−40, −20] / −48 [−73, −29]** | p50 289–325 / 322–355 |
| Api window pre-handler wait p90 / p99 | 71 / 152 ms | 96 / 205 ms | **−25 [−31, −19] / −53 [−64, −44]** | p90 67–78 / 79–103 |
| warm hop `api.fetch` HIT p50 / p99 | 4 / 8 ms | 4 / 8 ms | 0 [−1, 0] / 0 [−1, +1] | |
| CPU per scan (Σ window Api CPU + POST CPU) | 993 ms | 963 ms | **+30 [+21, +40]** (+3 %) | 975–1 025 / 942–979; S higher 6/6 |
| fresh isolates per run: front door (first computation) / Api | 0.3 / 762 | 0.3 / 781 | 0 [−0.5, +0.5] / −19 [−42, +9] | Api 723–861 / 684–847 |
| (secondary) cold scan client p50 / p90 | 440 / 620 ms | 469 / 664 ms | −29 [−39, −20] / −44 [−64, −30] | |

Also per run: front-door POST CPU p50 21–22 ms both; fresh Api isolate pre-router gap p50 87–91 (S) vs 115–122 ms (E).

Audit (dedup bug, 2026-10-30 22:25Z): the first pull of r1–r2 used `events_all`'s `$metadata.id` dedup (lost 25–37 % of
queue.py rows, 5–9 % of cold-split / cpu-by-version rows); r3 onward and the final r1–r2 were pulled with the whole-`$metadata`
key. A fresh re-pull of all 6 runs with the fixed scripts (scratchpad `audit/ab1/ab1.stats.txt`) reproduces every row; only
E's window wait moved (97 / 204 → 96 / 205 ms, CI −26 [−31, −20] / −52 [−61, −44] → above; late-ingested r4 rows). Decision unchanged.

**Decision: E.** S is faster (scans −29 ms p50, window waits −25 / −53 ms) but costs +3 % CPU per scan with a CI excluding
0, so by the pre-registered rule ephem-compute was removed: one Worker again (Api + BlockStore cache-enabled entrypoints of
ephem; deploy.sh `compute` target, bindings, packages/compute, smoke `--pin-compute` gone). The position tail the split
was built for did not show in either arm in this run (it was 0.35–5 % in earlier runs), so it is not what the split buys;
the speed came from the lean compute bundle's faster isolate start (gap ~89 vs ~119 ms), a lever available inside one
Worker. Earlier sequential runs (below) said the split had "no measured cost": they had no CPU-per-scan comparison.
Reviewed as a trade-off and confirmed (CoS, 2026-10-30): S's latency gains were measured only at 124 cold scans/min,
synthetic contention far above real search traffic, so they likely vanish at real load; warm and live paths were
unchanged; the second Worker's operational cost (compute deploy phase, canary pinning across a binding, interface
ordering between two Workers) is paid on every deploy. Deployed: ephem d3caf38f (git 7a125fd, 21:37Z; canary 23/23 +
telemetry gate, live 23/23 + live gate), ephem-tail 9c9403ec; a fresh key was MISS → HIT with `x-ephem-compute-version`
= d3caf38f; Api / BlockStore invocations on ephem d3caf38f; ephem-compute's last invocation 21:36Z.
Caveats: one client colo (EWR), one 30-min window, 6 runs; CPU per scan is a per-run scalar bootstrapped over runs only.
Dropping run 5 (an /instrument smoke, ~23 requests, hit both arms at ~21:04Z) changes nothing: CPU +32 [+21, +43],
e2e p50 −29 [−42, −19].

**Re-running** (trigger: search traffic approaching contention; re-run at that real load). Commit 5edf1b7 holds both arms
(the COMPUTE_MODE switch, `deploy.sh … ab` / `ab-end`, packages/compute). On a branch, restore them onto main (`git revert`
the code part of 7a125fd), deploy ephem-compute with that commit's deploy.sh (`compute` target), then `deploy.sh <rev> "…"
ab` (50/50, both arms smoked pinned; prints S and E ids), then:

```sh
node --experimental-strip-types scripts/obs/split-ab/load.ts <S> <E> ab2 6 240 60 60     # AB_DIR=ab-runs by default
python3 -I scripts/obs/split-ab/pull.py ab2 r1 … r6                                      # each run >= 5 min after it ends
AB_COMPUTE=<ephem-compute id> python3 -I scripts/obs/split-ab/stats.py ab2 r1 r2 r3 r4 r5 r6
scripts/deploy.sh <rev> "end A/B" ab-end
```

Set load.ts's rates to the real load being tested. Counts must match the client's (they did: ~495 scans per run and arm).

**History: the split as built and its first, sequential A/B.**

**Change** (git 01e0323): `Api` and `BlockStore` moved from `ephem` into a new Worker `ephem-compute` (packages/compute;
code packages/worker/src/compute.ts on the lean router src/router.ts, 365 KiB / 125 KiB gzip vs ephem's 472 / 163). ephem
keeps default (home, docs, MCP, live routes, weather, the search merge, Basin rows), MetarFeed and Admin and reaches compute
over service bindings `COMPUTE` (Api) and `STORE` (BlockStore). Hypothesis (guide "Position tail under scan load"): window
compute shared the front door's isolate pool, so under scan load the platform spawned more front-door isolates and live
requests landed on fresh ones. Deployed by deploy.sh: ephem-tail ab4e9a5d, ephem-compute bb0a1127, ephem 121b7984.

**A/B** (same harness as before: scratchpad `split/bin/ab.ts`, laptop EWR, cold 12-month Brooklyn Bridge Park scans in a
loop + `/v1/position` every 200 ms; before 647f5bbc 19:31:36–19:33:36Z and 19:39:40–19:43:39Z, after 121b7984 / bb0a1127
19:47:30–19:53:30Z; queue.py, cpu-by-version.py, scratchpad `split/bin/hop.py` on `search.window.fetch` / `api.fetch` spans):

| | before (647f5bbc, one Worker) | after (121b7984 + bb0a1127) |
| --- | --- | --- |
| cold scans / min (client) | 114–121 | 131–150 (scans got faster, so more load) |
| position probes waiting > 20 ms before the handler, under load (queue.py) | 5 / 1 420 = 0.35 % (4, 1, 0 per 2-min phase), 132–156 ms | 5 / 1 425 = 0.35 % (3, 2, 0), 141–205 ms |
| … of which new front-door isolate | 5 / 5 | 5 / 5 |
| same, idle phase | 0 / 473 | 2 / 464 (177, 269 ms, new isolates) |
| position server wait p50 / p90 / p99 (load) | 0 / 0 / 0–10 ms | 0 / 0 / 0–1 ms |
| position front-door CPU p50 / p90 / p99 | 2–3 / 4–5 / 7–12 ms | 3 / 5 / 10 ms |
| search POST front-door CPU p50 / p90 / p99 (merge) | 21–26 / 27–35 / 37–51 ms | 24 / 33 / 49 ms |
| Api window wait before the handler p50 / p90 / p99 | 0 / 109 / 213–216 ms (15.5–16.4 % > 20 ms) | 0 / 73 / 150 ms (13.4 %) |
| cold scan client p50 / p90 | 469–472 / 622–663 ms | 377–425 / 532–594 ms |
| warm scan (14 × HIT) client p50 | 84–109 ms | 87–127 ms |
| hop, warm: `api.fetch` HIT (front-door span) | 4 / 6 / 11 ms (ctx.exports, n = 56) | 4 / 6 / 7 ms (binding, n = 28) |
| hop, warm: `search.window.fetch` HIT, same workload | 12 / 15 / 20 ms (n = 350; was 336) | 13 / 18 / 66 ms (n = 364) |
| hop, cold: `search.window.fetch` MISS, same workload | 92 / 295 / 522 ms (n = 3 388; was 296, 3 360) | 93 / 260 / 458 ms (n = 3 635; was 259, 3 626) |

Hop rows re-derived 2026-10-30 22:25Z (hop.py deduplicated by `$metadata.id`): 0 id collisions in these single-span pulls, so
no events were dropped; n rose ~1 % from late ingest, percentiles moved ≤ 1 ms. Queue rows (traceId-keyed, no id dedup): unaffected.

**Verdict.** The split did **not** move the position tail: the same 0.35 % of probes waited, all on new front-door isolates,
and the after run carried ~20 % more scans. The front door still starts new isolates under this load (and did twice in
an idle phase), so window compute sharing the pool was not what made it spawn them; with the effect at 0.35 % of probes
and 0–5 per 2-min phase, the remaining cause is the platform's own isolate placement for the front door. What did move:
Api windows wait less before running (p90 109 → 73, p99 ~215 → 150 ms) and cold scans got ~50–90 ms faster at p50
(compute's leaner bundle and its own pool). The binding costs ≤ 1 ms over ctx.exports (HIT 4 ms either way). Front-door
CPU per request is unchanged. **Kept**: no measured cost, faster cold scans, and front-door and compute deploys are now
independent (compute canaries are pinned through the live front door). Not an answer to the position tail; next lever for
that is fewer cold front-door starts (smaller front-door bundle: home.ts 60 KB, or keeping live routes warm), unmeasured.

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
| front door CPU per POST (merge) | p50 21–25 / p99 35–55 ms (n = 12, 118); 37d28e99: cold p50/p90/p99 25/36/68 (n = 230), warm 22/37/86 (n = 24) |
| live `/v1/position` (front door) client latency, alone → during 124 cold scans/min | p50 38 → 38, p90 49 → 49, p99 69 → 232 ms (n = 249, 245) |

**Position tail under scan load (measured 2026-10-30, 8a308729 / 0d870218 / 37d28e99 / eb25caa2 / 647f5bbc; scratchpad
`search-p99/`).** The p99 69 → 232 ms above was one 60 s run (3rd-worst of 245 samples). Repeated from the same laptop,
client p99 of 60 s *idle* phases ranged 84–525 ms (n ≈ 230 each; laptop link stalls, one TLS read timed out), so client
p99 cannot resolve this; measure server-side with `queue.py`. What it shows, same load (cold scans ~124/min + position
every 200 ms):

| | idle | under cold scans |
| --- | --- | --- |
| position probes that waited > 20 ms before the handler | 0–0.9 % (0/490, 1/107, 2/438, 1/676) | 0.4–5.1 % (2/480, 17/331, 9/452, 8/674) |
| … of which on a **new isolate** (blocks/geoid not in L1) | all | 35 of 37; wait 70–234 ms + first-request CPU 18–71 ms |
| … waiting behind other JS in a warm isolate | — | 2 of 1 937 (23, 37 ms) |

So the tail is **front-door isolate start-up**: under scan load the runtime spreads EWR traffic over more isolates and a
live request sometimes lands on a new one (≈ 100–220 ms start-up, then a cold-JIT position at ~50 ms CPU). It is not CPU
contention with the merge: warm 14 × HIT scans at the same rate (merge only) gave 0 waits in 503 probes, and the merge is
small (front door CPU per POST p50 25 / p90 36 ms cold, 21–22 warm; window bodies 12.4–16.8 KB, 193 KB per scan, of which
region 2.3 KB + conventions 5.2 KB repeat in every window; in Node the whole POST is 2.3 ms steady state: JSON.parse 12 %,
building the 14 window keys 15 %, response encode ~12 %, the merge itself ~2 %). Window MISSes do share isolates with the
front door (an EWR CPU profile under scan load, 8a308729: 73 % `search.searchWindow`; EWR runs 20–24 % of window CPU,
≈ 0.4–0.5 core during the load), and Api windows themselves wait before starting (p90 ~105 / p99 ~210 ms, 14–15 % > 50 ms),
which is most of a cold scan's wall beyond its slowest window's CPU.

Tried and reverted: computing each window in ~5 ms slices (generator, a macrotask between slices; e2d5ac3, prod eb25caa2,
reverted in 0c29b78 → 647f5bbc). Windows ran in 9–10 slices and Node's longest event-loop gap fell 17–47 → 7–14 ms, but in
prod nothing moved: window wait p90/p99 109/218 → 102/205 ms, new-isolate position probes 2.0 → 1.2 % (inside the 0.4–5.1 %
run-to-run range), Api CPU per window p50 54 → 56 ms. Slicing cannot help a request that is waiting for an isolate to
start. Slimming the window JSON would cut front-door CPU a few ms per scan and is not worth a CACHE_VERSION bump for this.
The lever left was fewer CPU-heavy invocations on the front door's isolates: window compute in a separate Worker was done
on 2026-10-30 and did not move this tail (5/1 420 → 5/1 425 probes, still new front-door isolates); see "Compute split".

**Cold window cost (2026-10-30, 21250fb5 → 7708ca81 (git a7eb737, via 2015422) → 8413211a (git cdf06b0)).** Why window
MISS cost varies ~4×: **isolate warmth, not the window.** Evidence trace 8efbf0eb (21250fb5): its two MISSes did the same
work (1 269 vs 1 263 scan evaluations, 183 vs 135 track) but window 2027-03-03 ran on a warm EWR isolate (42 ms CPU, 62 ms)
and 2027-04-02 on a fresh IAD isolate (`ephem.isolate_computes` = 1: 112 ms before the handler, 90 ms CPU, 245 ms = the
scan's critical path). Over the A/B's E arm (cc6ddd8e, 41 617 windows, cold-split.py): fresh isolates were 11 % of windows,
27 % of window CPU, p50 139 vs 36 ms warm, plus ~119 ms start-up. Locally (Node, `window/bin/perwindow.ts`) a year of windows
differs ≤ 2× (bbox 5.6–10.3 ms, park 9.5–19.3 ms) with scan evaluations flat (1 259–1 285 per window): no window is
intrinsically heavy. And 80–91 % of cold scans had at least one fresh-isolate window; those were ~150 ms slower (client
p50 ~400 vs ~250 ms; `window/bin/fresh-split.py`). Two fixes, both measured:

1. **Less work, rigorously** (git a7eb737, CACHE_VERSION 8): altitude rate bound ω·cos φ + 1°/h at R (12.4°/h in NYC, was
   16), a latitude-aware azimuth bound, scan jumps on the azimuth too, and span ends pulled in by the same jumps (DESIGN
   §10.x). 12-month park scan: scan evaluations 16 649 → 6 210, track 4 376 → 2 563; same 64 / 125, Nov 16 entry
   03:45:19.646Z, entries/exits within 1 ms; brute force 1 s over 12 months 0 missed.
2. **Code V8 can optimise** (git cdf06b0, bit-identical output): `searchWindow` was one big function whose OSR'd inner loops
   deopted on every exit (~250 deopts per scan, TurboFan compiles 32–54 ms each, `node --trace-deopt`), so it mostly ran
   unoptimised and boxed every double (the edge loop alone ~146 MB per scan; inspector allocation sampling with collected
   objects, `window/bin/alloc.ts`). Inner loops are now small functions, edges come from a y-strip index, evalBlock fills
   scratch instead of a closure + 3 tuples per call. Node first (cold-JIT) run of the scan 201 → 104 ms, allocation 343 →
   160 MB. The prod profile (21250fb5, LOAD=search) had 19 % GC vs 1 % in Node, which is why allocation matters more there.

Prod, 124 cold 12-month park scans/min from EWR (unique keys), 3 × 120 s per version (`window/bin/load.ts`, `pull.py`;
server e2e = runtime POST start → Effect POST end; CPU per scan = Σ its 14 window Api CPU + POST CPU, own rays only):

| | 21250fb5 (before) | 7708ca81 (round 1) | 8413211a (round 2) |
| --- | --- | --- | --- |
| window MISS CPU p50 / p90 / p99 | 46–49 / 131–134 / 236–253 ms | 31–35 / 108–117 / 206–219 | **23–25 / 76–83 / 150–158** |
| … fresh isolate p50 / warm (> 20 computes) p50 | 133–135 / 35 | 114–116 / 22–23 | 96–101 / 19–20 |
| cold scan server e2e p50 / p90 | 291–319 / 455–499 ms | 276–298 / 429–495 | **227–233 / 379–395** |
| CPU per scan | 936–951 ms | 712–772 | **500–519** |
| scans with ≥ 1 fresh-isolate window | 80–84 % | 79–91 % | 63–70 % (p50 ~365 vs ~185 ms without) |
| window wait p90 / p99 | 80–97 / 184–194 ms | 45–103 / 178–207 | 19–50 / 180–185 |

What is left is isolate start-up: a scan that hits a fresh isolate pays ~119 ms before the handler plus ~100 ms first-request
CPU; window wait p99 (~180 ms) did not move. That is the next lever, not the search code.

## Instrument (`/instrument`): removed 2026-10-31

The RPN-calculator view (src/instrument.ts, instrument-engine.ts, instrument-ds.ts, their tests, scripts/instrument-ds.mjs,
the journey's `instrument-sky` script) was deleted (ivar: "delete /instrument, focus!!!!!!"); `/instrument` and the old
`/assets/<sha>/<file>` paths are 404 (smoke `instrument-gone`). The fonts it left for `/` (src/fonts.ts at
`/fonts/<sha12>/<file>`, scripts/instrument-fonts/) went too when `/` moved to system fonts only (2026-10-31; smoke
`fonts-gone`). Kept: src/embed.ts (first data streamed into the page). Last code: git 4ec0651 (deployed 02980cf0). Its measured results stay in
"Unified client+server traces" and "Findings" as history.

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

## Unified client+server traces (2026-10-30)

Every page view carries one W3C trace id from the browser through every server entrypoint, for real users (production RUM)
and for the lab harness (our own CDP client). Design: DESIGN §12.2. Code: src/clienttrace.ts, src/servertiming.ts,
src/rum.ts, scripts/obs/cdp/, scripts/obs/journey.ts, scripts/obs/trace-view.ts.

**Propagation.**

| Where | What |
| --- | --- |
| document `/` | front door adopts a valid `traceparent` (strict W3C: `00-<32 hex>-<16 hex>-<2 hex>`, lower case, non-zero) or uses the root request span's trace id; returns `<meta name="traceparent" content="00-<trace>-<root span>-01">` (OTel document-load), `Server-Timing: trace;desc="…"`, `x-ephem-trace`; `<meta name="ephem-synthetic">` when the request had `x-ephem-load` / `x-ephem-smoke` |
| page boot | reads meta → navigation `serverTiming` → fresh id (`window.__ephemTrace.from`: meta / server-timing / fresh) |
| every fetch (`__tfetch`) | `traceparent: 00-<trace>-<new span>-01`, `tracestate: ephem=<document span>` |
| root Effect span (front, Api) | `client.trace_id`, `client.span_id`, `client.parent_id`; documents: `client.document_span_id`, `client.trace_origin` (`adopted` / `minted`); `/rum`: `client.trace_id` of the batch |
| loopbacks | Api: the client's header (forwardHeaders); BlockStore, MetarFeed: the calling span's traceparent, recorded on a `loopback.trace` span. A block or band fetch is shared by concurrent requests in an isolate (in-flight dedup), so it carries the trace of the request that started it |
| never | the raw header beyond the two ids, tracestate other than `ephem=<16 hex>`, anything malformed (tests: test/clienttrace.test.ts) |

Query: spans with `client.trace_id = <id>` (o11y key `client.trace_id`) give every trace of the view; Basin
`ephem.requests_v2.trace_id` and `ephem.rum.trace_id` join by SQL.

**Server-Timing** (every front-door response; src/servertiming.ts): `trace` (documents first), `ray;desc="<cf-ray>"`, `api;desc="HIT";dur=`
(Api loopback), `api-blocks` / `api-geoid` (a fresh Api run only: a cached answer would replay another request's numbers),
`blocks;desc="L1 n=2";dur=`, `geoid`, `feed`, `trace` (a traceresponse for fetches), `total;dur=` (I/O wall). Durations are
the Workers clock, which only advances on I/O: wall around I/O, never CPU. **No CPU entry**: CPU is not readable inside a
request (`performance.now()` / `Date.now()` are frozen during compute); it is `cpuTimeMs` in o11y, joined by trace id or ray.
`Timing-Allow-Origin: *`, `Access-Control-Expose-Headers: server-timing, x-ephem-trace, x-ephem-version, x-ephem-cache`.

**Production RUM** (src/rum.ts `RUM_JS`, inline on both pages, 6.9 KB / 2.6 KB gzip, no deps): navigation and every resource
(Resource Timing phases + `serverTiming`), FCP, LCP, CLS (session window), INP (Event Timing, worst interaction), long
animation frames (longtask fallback), every fetch with its span ids, app spans `boot`, `data-ready`, `first-sky-draw`,
interactions `key` (soft key → stack drawn, key id) and `drag`. Batches go to `POST /rum` (sendBeacon on pagehide /
visibilitychange hidden, keepalive fetch every 15 s and 2 s after data-ready).

| `/rum` rule | Value |
| --- | --- |
| body | ≤ 64 KiB (413), JSON object `v: 1`, `tp` a valid traceparent (400), `page` `/`, ≤ 300 spans (413) |
| rate | ≤ 30 batches per trace per minute, ≤ 600 per 10 s per isolate (429; in-isolate, best effort) |
| privacy | DNT / GPC (header or navigator) → nothing sent or stored; sampled flag `00` → nothing; no IP, no UA (family only), no URL or query (targets are ROUTES ids, `/assets/<known file>`, `other`, `external`), names/details from fixed patterns, ids hex only |
| synthetic | `x-ephem-load`, `x-ephem-smoke`, `navigator.webdriver`, or the document's `<meta name="ephem-synthetic">` → `synthetic = true` |
| storage | Basin stream `ephem_rum` (3f7057f2…) → `ephem.rum`, one row per span (`trace_id`, `span_id`, `parent_id`, `kind`, `name`, `target`, `start_ms`, `dur_ms`, `value`, phases, `server_timing`, `cache`, `ray`, …: ops/basin/rum.schema.json) |

Request rows with trace ids: new stream `ephem_requests_v2` (82c448ef…, `ephem.requests_v2`: v1 columns + `schema`, `synthetic`,
`trace_id`, `span_id`, `client_span_id`, `client_parent_id`, `trace_origin`), dual-written with `ephem_requests` until
readers have moved. Streams/sinks/pipelines: `basin.py create-streams <stream>` then `basin.py provision <stream>` (before the
Worker binds them).

```sql
-- client spans joined to server request rows
SELECT r.kind, r.name, r.target, r.start_ms, r.dur_ms, q.route, q.status, q.api_cache, q.wall_ms
FROM ephem.rum r LEFT JOIN ephem.requests_v2 q ON q.trace_id = r.trace_id AND q.client_span_id = r.span_id AND q.role = 'front'
WHERE r.trace_id = '<id>' ORDER BY r.start_ms
```

**The CDP client** (scripts/obs/cdp/, no deps, `node --experimental-strip-types`): cdp.ts (launch Chrome headless/headed with
a temp profile and `--remote-debugging-port`, `/json/version`, one browser WebSocket, typed `send`, events, `waitFor`,
flattened sessions, per-command timeouts, teardown on exit/SIGINT/SIGTERM/uncaught: Chrome killed, profile removed),
page.ts (navigate + load / network idle, iPhone 390×844@3 and desktop 1440×900@2, Fast 3G / Fast 4G, CPU throttling, cold
cache, tap / drag / key / type, screenshots, Tracing with devtools.timeline, Network recorder with full timing and headers),
server.ts (o11y pull + ingest polling), model.ts (join, offset, tracks, critical path, costs, Perfetto), viewer.ts.

```sh
node --experimental-strip-types scripts/obs/journey.ts https://ephem.ivar.workers.dev/ --device iphone --cold   # Fast 3G + 4× CPU by default on iphone
node --experimental-strip-types scripts/obs/journey.ts https://ephem.ivar.workers.dev/ --device desktop --warm --duration 75
node --experimental-strip-types scripts/obs/trace-view.ts <trace-id>          # a real view from RUM + server telemetry only
node --experimental-strip-types scripts/obs/trace-view.ts --latest --real     # the newest non-synthetic RUM view
```

journey.ts: the document gets the harness's traceparent via Fetch interception (documents only). Not
`Network.setExtraHTTPHeaders`: it applies to every request of the page, so every fetch would carry the same span id instead of
its own. `x-ephem-load: <run>` does go on every request via setExtraHTTPHeaders (tags invocations; request rows `synthetic`).
Then: drive (`home-drag`: drag the sky left and right), dwell to `--duration`
(default 70 s: polls), leave the page (pagehide → RUM beacon), unthrottled clock probes, pull the server side (polls until every
request's root span and every MISS's Api invocation is in, `--wait`), pull the page's own RUM rows from Basin and check them
against CDP. Outputs `<name>.html` (self-contained viewer), `.perfetto.json` (ui.perfetto.dev), `.model.json`, `.rum.json`, `.png`.

**Clock offset** (model.ts). Each request with a server root span bounds θ = server − client: the root span starts after the
browser sent (t2 > t1 + θ) and its first byte (`cloudflare.response.time_to_first_byte_ms`) leaves before the browser had the
headers (t3 < t4 + θ), so θ ∈ (t3 − t4, t2 − t1), ±1 ms for whole-ms server times; the estimate is the midpoint of the
intersection over all requests. Width ≥ the network RTT, so ± ≈ RTT/2 at best. DevTools throttling adds its emulated latency
to what CDP reports, so throttled runs also use 12 unthrottled `/healthz` probes from the harness process (same system clock).
Independent check: `sntp time.apple.com`.

**Measured** (2026-10-31 00:05–00:19Z, ephem 2abe54b3, git b8746cc + journey f83752e; 75 s each; outputs and raw inputs:
scratchpad `journey/`):

| run | TTFB | FCP | LCP | data drawn | requests joined | θ ± (agree/n) | sntp | RUM vs CDP within 10 ms (max) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /instrument iPhone Fast 3G 4× cold (e428e61d) | 716 | 1078 | 1478 | 1606 | 11/11 | 79.0 ± 13.7 (23/23) | 82.3 ± 24.8 | 21/21 (1.9) |
| /instrument iPhone warm (df6e594f) | 576 | 768 | 768 | 1334 | 7/11, 4 browser cache | 79.8 ± 14.3 (19/19) | 82.8 ± 24.1 | 21/21 (0.6) |
| /instrument desktop cold (da821017) | 242 | 380 | 380 | 351 | 11/11 | 81.2 ± 15.1 (23/23) | 81.8 ± 21.9 | 29/29 (0.6) |
| /instrument desktop warm (32650451) | 38 | 88 | 88 | 104 | 7/11, 4 browser cache | 79.8 ± 14.6 (19/19) | 82.9 ± 26.0 | 25/25 (0.2) |
| / iPhone Fast 3G 4× cold (05927b60) | 694 | 957 | 957 | 1540 | 26/26 | 78.6 ± 14.5 (38/38) | 82.7 ± 24.2 | 60/60 (7.4) |
| / iPhone warm (926652ab) | 576 | 750 | 750 | 1337 | 22/25, 3 browser cache | 78.5 ± 14.1 (34/34) | 82.8 ± 23.9 | 59/60 (20.3) |
| / desktop cold (f5629ee6) | 228 | 286 | 286 | 337 | 26/26 | 81.4 ± 13.1 (37/38: /v1/track) | 81.9 ± 20.9 | 80/80 (8.7) |
| / desktop warm (251e41e4) | 39 | 61 | 61 | 110 | 22/25, 3 browser cache | 80.4 ± 14.0 (34/34) | 82.3 ± 21.6 | 76/77 (15.7) |
| real view /instrument, headed, RUM only (f53fb9c8) | 183 | 972 | 972 | 420 | 8/8 | 80.3 ± 15.6 (RUM bounds) | – | – |
| real view /, headed, RUM only (fbc4701c) | 280 | 316 | 340 | 349 | 20/21 (favicon 404: no ray) | 83.6 ± 10.5 (RUM bounds) | – | – |

- **Every request joins**: document, fonts, every fetch and poll (/ polls position every 5 s: 15 per run; weather at 60 s), the
  RUM beacons. Unjoined = browser cache hits (no server), and the real view's `/favicon.ico` 404 (a router error skips the
  Server-Timing middleware, so RUM has no ray for it). Document and every fetch also join by trace id (4/4 and 19/19 fetches
  carried the document's id).
- **Server inside client**: every front-door root span lies inside its request's send → first byte window (± θ uncertainty)
  in all runs but one request (/v1/track, desktop cold: a streamed body; its runtime TTFB 68 ms > the client's 52.7 ms send →
  headers, so it is also the one disagreeing offset bound).
- **Clock offset**: θ = server − laptop 78.5–81.4 ms, ± 13–15 ms (half the ~30 ms RTT: the method's floor), all bounds agreeing
  in 7 of 8 runs; sntp against time.apple.com 81.8–82.9 ± 21–26 ms. RUM-only reconstruction of the real views: 80.3 ± 15.6,
  83.6 ± 10.5. (Earlier the same laptop read 119.5 ± 17 vs sntp 125 ± 24: macOS slews its clock; measure per run.)
- **RUM vs CDP**: starts, ends, FCP, LCP, data-ready agree to p50 < 0.1 ms, max 20 ms (a warm disk-cache fetch); first byte
  under Fast 3G differs by −510 to −538 ms = the emulated latency (Resource Timing has the real first byte).
- **Top client-side costs** (iPhone Fast 3G, 4× CPU, cold):
  1. Fonts on /instrument: 3 fonts (37 KiB) finish 930 ms after the document's first byte (last at 1645 ms); the LCD's
     data is drawn at 1606 ms, so the dot fonts finish last on the critical path. Warm: 114 ms.
  2. /instrument's inline script forces a synchronous layout: one 135–142 ms long task at ~830 ms (EvaluateScript 137 ms, of it
     forced style + layout 127 ms, text shaping 80 ms), and the live `/v1/position` fetch only starts after it (1.01 s). Desktop:
     22 ms layout before data.
  3. The homepage keeps the main thread busy while idle: 673–820 ms script + 490–607 ms paint self time over 75 s at 4× CPU
     (earlier cold run 5b4aeaba: 860 BeginMainFrame in 75 s, PageAnimator::serviceScriptedAnimations 637 ms, Commit
     354 ms: the requestAnimationFrame loop runs while nothing changes), plus a 99 ms long task at load.
  The rest of the critical path is the network: `/v1/position` send → first byte 565–578 ms under Fast 3G with server CPU 2–5 ms.

**Gotchas.**
- Under DevTools throttling, CDP's `receiveHeadersEnd` includes the emulated latency; Resource Timing's `responseStart` (RUM)
  is the real first byte. RUM and CDP agree on starts and ends to < 1 ms and differ on first byte by ~the emulated latency.
- A RUM beacon at pagehide shows in CDP as `net::ERR_ABORTED` (the page is gone) though the server stored it: model.ts joins
  `/rum` requests to the trace's `/rum` invocations by order.
- Headless Event Timing durations (INP) are not comparable to a headed browser's.
- A comment inside a one-line JS function in the viewer template swallowed the rest of the line (blank viewer); use `/* */`.
- `cf o11y telemetry query` rejects fractional timeframe bounds (ZodError invalid_type): round them.
- `cloudflare.config.ts` pipeline bindings for new streams: a version upload once failed with `[10021] Pipeline binding error`
  (transient; the retry deployed).

## Homepage (`/`, src/home.ts, 2026-10-31)

- **One round trip.** GET / flushes the head (CSS, inline dot fonts, markup, boot script) at once, then streams
  `<script type="application/json" id="ephem-position|ephem-track|ephem-day">` with the API's own response bodies, run
  through the router in-process (src/embed.ts, shared with /instrument), then `</body>`. The page boots on DOMContentLoaded
  from the embed and fetches only what is missing (and weather). Span `home.embed` (attribute `home.embedded`: how many of
  the three made it). Mark `ephem:embedded` (all three used) or `ephem:fetched`.
- **Debug states:** `/?lat=&lon=&tz=&place=&at=<ISO>[&pose=<az>,<alt>]` freezes the page clock at `at` and asks
  `/v1/position?time=` (the embed is ignored). Real visitors never send it; `/` stays `private, no-store`.
  `node --experimental-strip-types scripts/obs/home-states.ts <base> <outDir> [filter]` shoots every sky state of the UI
  acceptance list (AGENTS.md) at 390×844, 375×667 and 1440×900 in both schemes and prints `window.__sky`'s layout per shot.
- **The chart draws only on change** (requestDraw: data, resize, theme, drag, pointing, fonts; once a second the tick checks
  whether a live marker, moved on by the answer's own rates, has moved half a pixel; at most once a minute otherwise). No
  rAF loop. `window.__sky.draws` counts frames. Idle cost from a journey: `python3 -I scripts/obs/journey-idle.py <name>.model.json`
  (top-level main-thread task time after data drawn + 6 s).
- **Labels:** one layout (`chartModel` + `layoutLabels` in CORE_JS) over bodies, events, bands and the scale;
  test/home.test.ts runs it over every sky state from the API's own answers (fixture blocks) at both phone sizes.

## Request logs (Basin)

One row per request in an Iceberg table, queryable with SQL: **Basin Pipelines** (stream) → **Basin Catalog** (Iceberg on
R2 bucket `ephem-logs`, warehouse `5ad2236b39de4c8bd8f6270ea63f3ea9_ephem-logs`, namespace `ephem`) → **Basin SQL**.

| Resource | Name / id | Notes |
| --- | --- | --- |
| stream | `ephem_requests` `d43e9589a2784812afda39033b6792eb` | schema `packages/worker/ops/basin/requests.schema.json`; Worker binding on, HTTP off; binding `LOGS` |
| stream | `ephem_invocations` `2d45db937f214e5cae5c19ba4c099779` | schema `ops/basin/invocations.schema.json`; written by `ephem-tail` (binding `INVOCATIONS`) |
| Tail Worker | `ephem-tail` (packages/tail) | attached via `tailConsumers` in packages/worker/cloudflare.config.ts; deploy `scripts/deploy.sh main "…" tail` (auto when packages/tail or src/routes.ts changed); route labels from packages/worker/src/routes.ts (shared with the request row) |
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
| `ua_family` | user agent / `mcp.client` / `x-ephem-load` | `curl`, `browser`, `mcp:<client name>`, `other`; `synthetic` for ephem-load traffic (header `x-ephem-load`; since 2026-10-30, ephem 5d347f60). The stream schema is immutable, so this is the synthetic flag instead of a new column. Synthetic rows' `country`/`city` are the Workers egress address's (US/New York), not the region's; `colo` is right |
| `lat_r`, `lon_r` | `lat`/`lon` (or `targetLat`/`targetLon`; MCP tool arguments) | rounded to 0.01° (~1 km) |

**Privacy rules** (tested): no IP, no raw path or query string, no full user agent, coordinates rounded to 0.01°. MCP client
names are reduced to `[a-z0-9._-]{≤32}`.

**Tail route labels.** ephem-tail's `route` comes from packages/worker/src/routes.ts, the request row's own list (tests:
it equals what the router serves, /openapi.json and /docs; the tail uses the same Set). Before e98a175b (git 64d7ce8) it had
its own list and labelled /v1/track, /v1/sightline, /v1/alignment/search(+/window), /llms.txt and /docs/interactive "other".
Each tail() call logs `{"tail_batch":{"rows":n,"routes":["<entrypoint> <route> <n>",…]}}`, read by
`scripts/obs/tail-check.py`; on e98a175b after deploy.sh's smoke: `- /v1/track 2`, `- /v1/sightline 1`,
`- /v1/alignment/search 1`, `- /llms.txt 1`, `- /docs/interactive 1`, 0 non-ok outcomes, 0 `basin_send_failed`.

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
| 2026-10-30 | 8a308729, 0d870218, 37d28e99 → eb25caa2 (e2d5ac3) → 647f5bbc (0c29b78, revert) | Position p99 under cold-scan load: client p99 from the laptop is noise (idle 60 s phases 84–525 ms). Server-side (`queue.py`), 0.4–5.1 % of probes under load vs 0–0.9 % idle waited 70–234 ms before the handler, 35 of 37 on a **new front-door isolate**; 2 of 1 937 waited (23, 37 ms) behind JS in a warm isolate. Merge-only load (14 × HIT at the same rate): 0 / 503. Front-door CPU per scan p50 25 ms (cold) / 22 (warm). Sliced window compute: no measured effect (window wait p99 218 → 205 ms, new-isolate probes 2.0 → 1.2 %), reverted. | cause is isolate start-up, not merge CPU; next lever: window compute off the front door's isolates |
| 2026-10-30 | 647f5bbc → 121b7984 + ephem-compute bb0a1127 (git 01e0323) | Api + BlockStore moved to their own Worker (service bindings, same keys, callee's Workers Caching verified MISS → HIT). Position probes waiting > 20 ms under ~120–150 cold scans/min: 5/1 420 → 5/1 425 (0.35 %), all new front-door isolates either way. Api window pre-handler wait p90/p99 109/215 → 73/150 ms; cold scan p50 470 → 380–425 ms; binding hop ≤ 1 ms (api.fetch HIT 4 ms both). | split kept; the position tail is front-door isolate start-up that the split does not change (guide "Compute split") |
| 2026-10-30 | S ephem 02dd1270 + ephem-compute fca6e275 vs E ephem cc6ddd8e (git 5edf1b7), 20:42:57–21:11:57Z | Concurrent A/B of the compute split (one commit, two versions 50/50, both arms pinned and loaded at the same instants; 6 × 240 s). S − E [95 % CI]: cold scan server e2e p50 −29 [−40, −20] ms, p90 −48 [−73, −29]; window wait p90 −25 [−31, −19], p99 −53 [−64, −44] (re-pulled after the dedup fix; was −26 / −52); **CPU per scan +30 [+21, +40] ms (993 vs 963, +3 %)**; position waits > 20 ms 1/7 324 vs 2/7 337, warm hop 4/8 ms both, fresh isolates equal. | pre-registered rule → E, confirmed: the latency gain was measured only at synthetic contention (124 cold scans/min), warm/live paths unchanged, two-Worker cost on every deploy. ephem d3caf38f (git 7a125fd), ephem-compute deleted; re-run at real load if search nears contention (5edf1b7 holds both arms; guide "Compute split") |
| 2026-10-30 | 8a308729 → 0d870218 (git ac69e35) | Rates analytic (DE440 velocity) instead of a ±10 s difference: the flaky rate property was the nadir side (5.6e-5 vs 1e-5 within 10° of it); now ≤ 3.6e-7 vs Richardson, 0 exceedances in 400k body-samples above −89° (guide "Rates"). Local: position() 18.5 → 12.8 µs, ratesAt 4.0 → 2.3 µs. Prod /v1/track (no rates; `LOAD=track` 120 cold, 13:19:25–13:19:50Z) Api CPU p50 13 / p90 65 / p99 108 ms vs 9 / 61 / 101 on e4d16979 (n=242): unchanged, isolate warmth. | rates 25–60× closer to the positions; position CPU −31% |
| 2026-10-30 | 02dd1270 → 639e952a (git 5026667 ⊇ 5d9103c) | **/instrument** (RPN view): bundle 474.46 → 590.04 KiB (gzip 164.08 → 221.19); local `cf workers check` median active/window 36.3/55.1 → 36.3/54.8 ms (6 alternating runs); deploy-reported startup 56 ms (n=1) vs 43, 44, 50, 51 ms for the previous four 474 KiB uploads. Prod browser (390×844, fresh context + never-seen lat/lon, n=7): 2 API requests cold and warm (+ 3 fonts, `(cache)` warm), HTML 18.3 KB on the wire. | data rendered p50 cold 388 / warm 88 ms; /v1/day rendered 552 / 53 ms (scratchpad instrument/prod.json) |
| 2026-10-30 | 21250fb5 → 7708ca81 (git a7eb737) → 8413211a (git cdf06b0) | Cold search windows: the ~4× MISS spread is isolate warmth (trace 8efbf0eb: same work, fresh IAD isolate 112 ms start-up + 90 vs 42 ms CPU); windows are not intrinsically heavy (≤ 2× over a year, scan evaluations flat). (1) rigorous tighter scan bounds + azimuth jumps + span trimming (CACHE_VERSION 8): scan evals 16 649 → 6 210, track 4 376 → 2 563 per 12-month scan, same 64/125, brute force 0 missed. (2) searchWindow split into small functions (OSR deopts ~250/scan, boxed doubles), edge strip index, evalBlock allocation-free: bit-identical, allocation 343 → 160 MB/scan. Prod 124 scans/min, 3 runs each: window MISS CPU p50/p90/p99 46–49/131–134/236–253 → 23–25/76–83/150–158 ms; scan e2e p50/p90 291–319/455–499 → 227–233/379–395 ms; CPU per scan 936–951 → 500–519 ms. | left: fresh-isolate start-up (~119 ms + ~100 ms first-request CPU; 63–70 % of cold scans hit one); guide "Alignment search" |
| 2026-10-30 | 2abe54b3 → ed72f155 | `/` had no `<link rel=icon>`: Chrome fetched `/favicon.ico` after load, a 404 through the whole Effect app + a Basin send (J20261031T000045Z-y64q: 117 ms send → first byte, 844 ms wall incl. waitUntil). It was never awaited: journey's critical-path heuristic named it because it ended 0.5 ms after the data fetches (now: only requests the page can wait on; no wait cost for browser-cache hits). Fix: inline SVG data-URI icon on every page (src/favicon.ts), `/favicon.ico` answered before the app (immutable 1 y, no request row). The 2302 ms home-drag INP was the old scripted-input heuristic in headless (no frame without damage); the page's Event Timing said 24 ms; journey reports RUM INP since 73cd018. | `/` requests 26 → 24, 0 favicon; home INP (RUM) iPhone Fast 3G 4× headed 32 ms, desktop 16 ms. /instrument headless INP (616–968 ms) is a headless artifact; headed 112 ms, all presentation delay (main thread ≤ 4 ms tasks, processing ~1 ms): J20261031T003009Z-cfkr |
| 2026-10-31 | ed72f155 → 7ba3757b (ea93c12) → 02980cf0 (4ec0651) → removed | /instrument's client costs: first data embedded + streamed (src/embed.ts), fonts inline, no forced layout. iPhone Fast 3G 4× cold (J…T002502Z-ilza → J…T004812Z-tipt): data drawn 1732 → 1229 ms (= FCP; 6 → 1 request before data), FCP 1202 → 1229; warm (fu9f → 599c) data 1346 → 1007 but FCP 771 → 982 (document 22.6 → 49 KB; data: URL fonts decode asynchronously, so the first frame's text was invisible and a second layout preceded FCP). The headed real view's 972 ms FCP (f53fb9c8) was a fresh Chrome's GPU process (Dawn/Graphite pipeline compiles: raster flushes 302 + 328 ms; same page with a warm GPU process 135 ms; this page's own cold-cache pipelines ~33 ms). | page deleted (ivar); src/embed.ts and the fonts (src/fonts.ts) stay for `/` |


## Gotchas

- A commit that adds a front-door route AND changes worker/src fails deploy.sh's compute phase: the compute canary smoke is the new
  commit's smoke.sh against the old front door, so the new route 404s (5d9103c: `instrument`, `instrument-font`, canary 78fb7429
  removed, 2026-10-30). Deploy the `ephem` target first; compute catches up on the next `auto`.
- Client p99 from the laptop can't measure a server-side tail: idle 60 s phases of `/v1/position` every 200 ms ranged
  84–525 ms p99 (2026-10-30), and the laptop's link stalls (fetches hung for minutes; give every fetch a timeout). Use
  `queue.py` (wait before the handler, per request) and invocation CPU joined by cf-ray.

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
- **`curl … | grep -q …` under `set -o pipefail` is a false failure**: grep exits at the first match, curl's next write gets
  EPIPE (exit 23), the pipeline fails. It failed a healthy /docs 29 of 100 times from EWR (match at byte 748 of 16 469;
  10/10 with `--limit-rate 4k`), and is the cause of 1bff6e62's "/docs has no /openapi.json link": o11y shows every /docs
  request to 1bff6e62 (13:18:12–13:18:33Z) returned 200. smoke.sh writes bodies to files and greps those
  (`echo "$S" | head -1 | grep` had the same flaw). Repro: scratchpad `deploy/repro-pipefail.sh`.
- **`$metadata.id` is not unique; dedupe by the whole `$metadata` (or rayId + type), never by id.** One query returned 78
  rows for 78 distinct cf-rays with only 67 distinct ids (smoke run g1793394107, 2026-10-30). Ids collide across event kinds:
  20:43–20:44Z (A/B load) ephem invocations 2 879 events / 2 497 ids, spans 33 226 / 26 981 (geoid.load, search.window.fetch,
  blocks.load most often); ephem-compute 1 727 / 1 585 and 18 328 / 14 564. `telemetry.events_all` deduplicated by id from
  33ac398 (20:32Z) to 5026667 (21:12Z) and silently dropped events: /v1/position 20:50–21:00Z kept 2133 of 2478 (cc6ddd8e)
  and 2116 of 2459 (02dd1270). The loss depends on the tool, not only the window: in the compute A/B's first pull of r1–r2,
  queue.py (joins two spans per request) lost 25–37 % of rows, cold-split.py / cpu-by-version.py 5–9 %. That was the "15–24%
  o11y loss": it is not ingest loss. Fixed (whole `$metadata`; canary-gate.py the same). A pull filtered to one span name
  can be clean (split/bin/hop.py, same id dedup, 19:00–20:10Z: 0 collisions in 8 006 rows), so check, don't assume. Independent
  cross-check, same 10 min: o11y invocations front 9414 / Api 13898, root spans 9403 / 13896, ephem-tail `tail_batch` rows
  (the tail Worker feeding Basin `ephem.invocations`) 9410 / 13906, all within 0.1%. Count rays or traceIds. Audit of every finding (2026-10-30
  22:25Z): only the two A/B tables in "Compute split" used an id dedup; both re-pulled (retention 7 days), changes ≤ 1 ms.
- Spans carry the version as `source.cloudflare.script_version.id` and the entrypoint as `source.cloudflare.entrypoint`
  (no `$workers`); filter spans by ray with key `cloudflare.ray_id` (root spans only). Console JSON lines have no
  `$metadata.level`; `console.error` lines have level `error`.
- Workers Observability splits JSON log keys on ".": `{"routes":{"- /llms.txt":1}}` came back as
  `{"- /llms":{"txt":1}}` (ephem-tail 9b316309). Log label/count pairs as strings ("- /llms.txt 1"), not as object keys.
- The default handler's TailItem has no `entrypoint` (ephem-tail labels it "-"); only `Api`, `BlockStore`, `MetarFeed` carry one.
  ephem-tail labels another script's entrypoint `<script>/<entrypoint>` from the TailItem's `scriptName`
  (`ephem-compute/Api` rows exist for 2026-10-30 19:44Z – 21:37Z; a schema change would need a new stream).
- The o11y query API rate-limits bursts: 6 obs scripts × 8 parallel slices got `429 [971] Please wait and consider
  throttling` (2026-10-30). `events_all` must fail loudly on a failed slice, never return a partial result; run pulls one
  tool at a time.
- `scripts/obs/queue.py` shadows the stdlib `queue` module for every script in that directory: `concurrent.futures` (and
  anything else importing `queue`) fails with a circular import. `events_all` uses `threading` directly.
- `npm install` in the shared tree removes the per-package `node_modules/wrangler` symlinks cf needs (`wrangler is declared
  in packages/worker/package.json but is not installed`): cf checks `<package>/node_modules/wrangler/package.json`. Restore
  with `ln -sfn "$PWD/node_modules/wrangler" packages/<p>/node_modules/wrangler` (worker, tail, compute) (2026-10-30).
- `/v1/day` needs `tz`; `/v1/position` takes `time` optionally (default now).
- `/v1/track` rejects a start/end off the stepSeconds grid (422 naming the snapped values): snap on the client so keys are
  shared. The homepage's live poll has no `time`: with one it would be forwarded and leave a single-use immutable entry.
- Invocation `wallTimeMs` includes waitUntil: with Basin request rows on, every invocation carries a ~1 s `send` (see
  "Request logs (Basin)"), so compare wall only between versions with the same `REQUEST_LOGS` setting.
- MCP: the probe and Inspector speak legacy 2025-11-25; Claude Code 2.1.312 speaks 2026-07-28 directly (no initialize).
  Both must keep working; the probe covers both eras.
