"""Telemetry gate for a deploy: reads Workers Observability for the requests a smoke just sent and fails on what the client
can't see (exceptions, error logs, 5xx inside a 200 flow, missing entrypoints). deploy.sh runs it after the pinned canary
smoke (before promotion) and after the live smoke (with --live, over real traffic too).

    python3 scripts/obs/canary-gate.py <worker> <new-version> <prev-version|-> --since ISO --run <smoke run id> --manifest FILE
        [--wait 90] [--live SECONDS] [--baseline-min 15] [--json out.json]

<worker>   ephem (the version under test: front door, Api and BlockStore all run in it)
--run      the smoke's run id: smoke.sh --run sends `x-ephem-smoke: <run>` on every request (curl checks and the MCP probe), so
           the gate selects exactly the smoke's front-door invocations; other traffic can't pollute the counts
--manifest smoke.sh --manifest: one line per request the smoke sent, `<cf-ray> <status> <method> <path> <check>`
--wait     seconds to wait for ingest (default 90). The gate polls until every manifest ray is visible (invocation event or the
           runtime root span) and every required span is present; at the deadline the --coverage floor decides (missing telemetry
           never passes).
--live S   after promotion: also judge ALL traffic the new version served in [since, since+S] (waits until then)

Joins: front-door invocation (header x-ephem-smoke) → cf-ray → Api invocations (request header x-ephem-ray = front ray)
and BlockStore invocations (rayId starts with the front ray) on ephem →
traceIds → every span and log line of those traces. Plus every invocation and log line of <new-version> in the window
(at 0% only pinned requests reach it: the smoke, deploy.sh's /healthz polls).

FAIL on (rule; see docs/telemetry_and_profiling.md "Telemetry gate"):
  missing      at the deadline: coverage below --coverage (0.95) of the smoke's requests, a smoke check (route) with no
               front-door invocation at all, or a required entrypoint/span absent
  version      a smoke request answered by another version of <worker> than <new-version>
  outcome      any invocation with outcome != ok (live: a user's `canceled` is a warning, it is their disconnect)
  5xx          any 5xx; or a front-door status that differs from what the client recorded
  error log    any log line at level error, any key ending in `_failed` (basin_send_failed, request_log_failed), any
               {"evt": "*_failed"}
  live         an error of a signature (service, entrypoint, kind, path/evt) the previous version did not show in its
               baseline window; a signature the previous version also shows is a warning (pre-existing)
WARN only: CPU p50/max per (entrypoint, path) vs the previous version's last --baseline-min minutes: new p50 > 2x base p50
  and +5 ms, or new max > base p99 + 50 ms (base n >= 10). Not a failure: the smoke sends 1-3 requests per route to fresh
  isolates, whose first request pays isolate start-up (cold-split.py: 1.2-2x CPU), so the noise exceeds any rule we could
  defend at that n.
Exit 0 pass, 1 fail.
"""
import argparse, collections, json, sys, time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).parent))
import telemetry as t  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("worker", choices=["ephem"])   # ephem-compute (a separate Api Worker) was removed 2026-10-30, DESIGN §12.0
ap.add_argument("new"); ap.add_argument("prev")
ap.add_argument("--since", required=True); ap.add_argument("--run", required=True); ap.add_argument("--manifest", required=True)
ap.add_argument("--wait", type=float, default=90); ap.add_argument("--live", type=float, default=0)
ap.add_argument("--baseline-min", type=float, default=15); ap.add_argument("--json")
ap.add_argument("--coverage", type=float, default=0.95, help="minimum share of the smoke's requests that must be visible")
a = ap.parse_args()
PREV = None if a.prev in ("", "-") else a.prev
ms = lambda s: int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)  # noqa: E731
iso = lambda m: datetime.fromtimestamp(m / 1000, timezone.utc).strftime("%H:%M:%S.%f")[:-5] + "Z"  # noqa: E731
T0 = ms(a.since) - 5_000   # clock skew between this laptop and the edge
COMPUTE_SVCS = ["ephem"]   # Api/BlockStore are ephem's own entrypoints
NOT_SPAN = {"key": "$metadata.type", "operation": "neq", "type": "string", "value": "span"}
INV = t.eq("$metadata.type", "cf-worker-event")
inn = lambda k, vs: {"key": k, "operation": "in", "type": "string", "value": ",".join(vs)}  # noqa: E731
chunks = lambda xs, n: [xs[i:i + n] for i in range(0, len(xs), n)]  # noqa: E731

man = []
for ln in Path(a.manifest).read_text().splitlines():
    p = ln.split()
    if len(p) >= 5 and p[0] not in ("", "-"):
        man.append(dict(ray=p[0].split("-")[0], status=int(p[1]) if p[1].isdigit() else 0, method=p[2], path=p[3], check=p[4]))
rays = {m["ray"] for m in man}
if not man:
    print("GATE FAILED: the manifest lists no requests (did the smoke run with --manifest?)"); sys.exit(1)


def ver(e): return (e.get("$workers") or {}).get("scriptVersion", {}).get("id") or (e.get("source") or {}).get("cloudflare", {}).get("script_version", {}).get("id", "")
def ep(e): return (e.get("$workers") or {}).get("entrypoint") or (e.get("source") or {}).get("cloudflare", {}).get("entrypoint") or "default"
def svc(e): return e["$metadata"].get("service", "")
def req(e): ev = (e.get("$workers") or {}).get("event"); return ev if isinstance(ev, dict) else {}
def status(e): return req(e).get("response", {}).get("status")
def path(e): return urlparse(req(e).get("request", {}).get("url", "")).path
def ray0(e): return (e["$metadata"].get("rayId") or "").split("-")[0]


def from_root_span(sp):
    """An invocation-shaped record from a runtime root span (fetch handler), for a request whose invocation event is lost."""
    c, src = sp["source"].get("cloudflare", {}), sp["source"]
    return {"$metadata": {"type": "cf-worker-event", "service": sp["$metadata"].get("service"), "rayId": c.get("ray_id"),
                          "traceId": sp["$metadata"].get("traceId"), "from": "root span"},
            "$workers": {"scriptVersion": c.get("script_version", {}), "outcome": c.get("outcome"), "cpuTimeMs": src.get("cpu_time_ms", 0),
                         "event": {"request": {"url": (src.get("url") or {}).get("full", "")}, "response": {"status": ((src.get("http") or {}).get("response") or {}).get("status_code")}}}}


def collect(until: int):
    w = (T0, until)
    front = [e for e in t.events_all([INV, t.eq("$workers.event.request.headers.x-ephem-smoke", a.run)], w, service="ephem")]
    # Second, independent record of every request: the runtime's root span (cloudflare.ray_id, outcome, status, version,
    # cpu). An invocation event can be lost at ingest while its span arrives (1 of 154 smoke requests, 2026-10-30); such a
    # request still counts as visible, judged from its span.
    have = {ray0(e) for e in front}
    for c in chunks(sorted(rays - have), 40):
        for sp in t.events(0, [t.eq("$metadata.type", "span"), inn("cloudflare.ray_id", c)], window=w, service="ephem"):
            front.append(from_root_span(sp))
    fr = {ray0(e) for e in front}
    linked = []
    for s in COMPUTE_SVCS:
        for c in chunks(sorted(fr), 40):
            linked += t.events(0, [INV, inn("$workers.event.request.headers.x-ephem-ray", c)], window=w, service=s)
        linked += [e for e in t.events_all([INV, t.eq("$workers.entrypoint", "BlockStore")], w, service=s) if ray0(e) in fr]
    traces = sorted({e["$metadata"].get("traceId") for e in front + linked} - {None})
    tev = []
    for s in ["ephem"]:
        for c in chunks(traces, 15):
            tev += t.events(0, [inn("$metadata.traceId", c)], window=w, service=s)
    newsvc = "ephem"
    lw = (T0, max(until, T0 + 1)) if not a.live else (ms(a.since), until)
    mine = t.events_all([t.eq("$workers.scriptVersion.id", a.new), NOT_SPAN], lw, service=newsvc)
    return front, linked, tev, mine


def is_err_log(e):
    if e["$metadata"].get("type") != "cf-worker":
        return None
    src = e.get("source") if isinstance(e.get("source"), dict) else {}
    lvl = e["$metadata"].get("level") or src.get("level")
    failed = [k for k in src if k.endswith("_failed")] + ([src["evt"]] if str(src.get("evt", "")).endswith("_failed") else [])
    if lvl == "error" or failed:
        return (failed[0] if failed else "error") + ": " + json.dumps(src)[:160]
    return None


def judge(front, linked, tev, mine, final: bool):
    fails, warns, missing = [], [], []
    byray = collections.defaultdict(list)
    for e in front: byray[ray0(e)].append(e)
    # completeness and status agreement
    got = len(set(byray) & rays)
    if got < a.coverage * len(rays): missing.append(f"coverage {got}/{len(rays)} smoke requests visible, below {a.coverage:.0%}")
    for chk in sorted({m["check"] for m in man}):
        if not any(byray.get(m["ray"]) for m in man if m["check"] == chk): missing.append(f"no invocation or root span for check {chk}")
    for m in man:
        es = byray.get(m["ray"], [])
        if not es: continue
        st = status(es[0])
        if m["status"] and st != m["status"]: fails.append(f"status: {m['check']} {m['path']} server {st}, client saw {m['status']} (ray {m['ray']})")
    # version under test answered
    for e in front:
        if ver(e) != a.new: fails.append(f"version: {path(e)} answered by ephem {ver(e)[:8]} (ray {ray0(e)})")
    for e in linked:   # ctx.exports runs the caller's version: a forwarded MISS on another version is a routing bug
        if ver(e) != a.new: fails.append(f"version: {ep(e)} {path(e)} ran on {ver(e)[:8]} (ray {ray0(e)})")
    # outcomes, 5xx, error logs: the smoke's invocations, everything on their traces, everything the new version ran
    seen, errs = set(), []
    for e in front + linked + tev + mine:
        i = json.dumps(e["$metadata"], sort_keys=True)   # $metadata.id is not unique (guide gotcha)
        if i in seen: continue
        seen.add(i)
        where = f"{svc(e)}/{ep(e)} {ver(e)[:8]}"
        if e["$metadata"].get("type") == "cf-worker-event":
            o, st = e["$workers"].get("outcome"), status(e)
            if o and o != "ok": errs.append((e, f"outcome {o}", f"outcome: {where} {path(e)} {o} (ray {ray0(e)})"))
            if isinstance(st, int) and st >= 500: errs.append((e, f"status {st}", f"5xx: {where} {path(e)} {st} (ray {ray0(e)})"))
        elif e["$metadata"].get("type") == "span" and isinstance(e.get("source"), dict) and "ray_id" in e["source"].get("cloudflare", {}):
            c = e["source"]["cloudflare"]; sc = ((e["source"].get("http") or {}).get("response") or {}).get("status_code")
            pth = (e["source"].get("url") or {}).get("path", "")
            if c.get("outcome") not in (None, "ok"): errs.append((e, f"outcome {c.get('outcome')}", f"outcome (root span): {where} {pth} {c.get('outcome')} (ray {c.get('ray_id')})"))
            if isinstance(sc, int) and sc >= 500: errs.append((e, f"status {sc}", f"5xx (root span): {where} {pth} {sc} (ray {c.get('ray_id')})"))
        else:
            m = is_err_log(e)
            if m: errs.append((e, "log " + m.split(":")[0], f"error log: {where} {m} (ray {ray0(e)})"))
    key = lambda e: json.dumps(e["$metadata"], sort_keys=True)  # noqa: E731
    smoke_ids = {key(e) for e in front + linked + tev}
    for e, kind, msg in errs:
        if a.live and key(e) not in smoke_ids:   # real traffic: judge by signature against the previous version
            sig = (svc(e), ep(e), kind, path(e))
            if kind == "outcome canceled": warns.append("live (client disconnect): " + msg)
            elif sig in BASE_SIGS: warns.append("live (pre-existing on prev): " + msg)
            else: fails.append("live: " + msg)
        else:
            fails.append(msg)
    # entrypoints and spans the smoke must have exercised
    spans = [e for e in tev if e["$metadata"].get("type") == "span"]
    names = collections.Counter((ep(e), e["$metadata"].get("spanName")) for e in spans)
    api = [e for e in linked if ep(e) == "Api"]; bst = [e for e in linked if ep(e) == "BlockStore"]
    forced = [e for e in spans if e["$metadata"].get("spanName") == "blocks.load" and ep(e) == "Api" and "MISS" in str((e["source"].get("ephem") or {}).get("blocks_cache", ""))]
    need = [("default span GET", names[("default", "GET")] > 0),
            ("default span POST /mcp", names[("default", "POST")] > 0), ("default span api.fetch", names[("default", "api.fetch")] > 0),
            ("MCP span mcp.tools/call", names[("default", "mcp.tools/call")] > 0), ("MCP span mcp.initialize", names[("default", "mcp.initialize")] > 0),
            ("Api invocation", len(api) > 0), ("Api span position", names[("Api", "position")] > 0), ("Api span blocks.load", names[("Api", "blocks.load")] > 0),
            (f"BlockStore invocation ({len(forced)} forced MISS)", len(bst) > 0 or not forced)]
    missing += [f"no {n}" for n, ok in need if not ok]
    return fails, warns, missing, dict(api=api, bst=bst, forced=forced, names=names, need=need)


def pct(v, p): v = sorted(v); return v[min(len(v) - 1, int(len(v) * p))] if v else None


BASE_SIGS, BASE = set(), collections.defaultdict(list)
if PREV:
    bw = (ms(a.since) - int(a.baseline_min * 60_000), ms(a.since))
    bsvc = "ephem"
    for e in t.events_all([t.eq("$workers.scriptVersion.id", PREV), NOT_SPAN], bw, service=bsvc):
        if e["$metadata"].get("type") == "cf-worker-event":
            BASE[(ep(e), "/block/…" if ep(e) == "BlockStore" else path(e))].append(e["$workers"].get("cpuTimeMs", 0))
            o, st = e["$workers"].get("outcome"), status(e)
            if o and o != "ok": BASE_SIGS.add((svc(e), ep(e), f"outcome {o}", path(e)))
            if isinstance(st, int) and st >= 500: BASE_SIGS.add((svc(e), ep(e), f"status {st}", path(e)))
        else:
            m = is_err_log(e)
            if m: BASE_SIGS.add((svc(e), ep(e), "log " + m.split(":")[0], path(e)))

early = False
start = time.time(); deadline = start + a.wait; live_end = ms(a.since) + int(a.live * 1000)
polls = 0
while True:
    polls += 1
    front, linked, tev, mine = collect(int(time.time() * 1000))
    fails, warns, missing, info = judge(front, linked, tev, mine, False)
    complete = not missing and len({ray0(e) for e in front} & rays) == len(rays)   # stop early only at 100%; floor applies at the deadline
    if fails and not a.live: early = True; break          # an error is definitive: no need to wait for the rest
    if complete and (not a.live or time.time() * 1000 >= live_end + 15_000): break
    if time.time() >= deadline and (not a.live or time.time() * 1000 >= live_end + 15_000): break
    if polls == 1 or polls % 3 == 0:
        print(f"  gate: {len({ray0(e) for e in front} & rays)}/{len(rays)} smoke requests ingested, {len(missing)} missing, {time.time() - start:.0f}s", flush=True)
    time.sleep(10 if a.live else 5)
waited = time.time() - start
first_complete = waited if complete else None

# --- table ---------------------------------------------------------------------------------------------------------------
under = "ephem (front door, Api, BlockStore)"
print(f"== telemetry gate: {a.worker} {a.new[:8]} vs {PREV[:8] if PREV else '-'} | run {a.run} | {under}{' | live ' + str(int(a.live)) + 's' if a.live else ''}")
nspan = sum(1 for e in front if e["$metadata"].get("from") == "root span")
print(f"   ingest: coverage {len({ray0(e) for e in front} & rays)}/{len(rays)} smoke requests visible after {waited:.0f}s ({polls} polls; floor {a.coverage:.0%}; {nspan} only by root span); "
      f"{len(info['api'])} Api + {len(info['bst'])} BlockStore invocations linked; {len(tev)} trace events; {len(mine)} events on {a.new[:8]}")
rows = collections.defaultdict(lambda: dict(n=0, st=collections.Counter(), cpu=[], ver=set()))
for e in front:
    r = rows[("default", path(e))]; r["n"] += 1; r["st"][status(e)] += 1; r["cpu"].append(e["$workers"].get("cpuTimeMs", 0)); r["ver"].add(ver(e)[:8])
for e in info["api"] + info["bst"]:
    r = rows[(ep(e), path(e) if ep(e) == "Api" else "/block/…")]; r["n"] += 1; r["st"][status(e)] += 1; r["cpu"].append(e["$workers"].get("cpuTimeMs", 0)); r["ver"].add(ver(e)[:8])
print(f"   {'entrypoint':10} {'path':24} {'n':>3} {'status':10} {'version':9} {'cpu p50':>7} {'max':>4} | {'prev p50':>8} {'p99':>4} {'n':>5}  cpu")
cpu_warn = []
judged = ("default", "Api", "BlockStore")   # one Worker: all of it is the version under test (CPU warnings only)
for (e_, p_), r in sorted(rows.items()):
    b = BASE.get((e_, p_), []); bp50, bp99 = pct(b, .5), pct(b, .99); np50, nmax = pct(r["cpu"], .5), max(r["cpu"])
    flag = ""
    if e_ in judged and len(b) >= 10:
        if np50 > 2 * bp50 and np50 - bp50 >= 5: flag = f"WARN p50 {np50} > 2x {bp50}"
        elif nmax > bp99 + 50: flag = f"WARN max {nmax} > p99 {bp99} + 50"
    elif e_ in judged: flag = "(base n<10)"
    if flag.startswith("WARN"): cpu_warn.append(f"cpu: {e_} {p_} {flag[5:]}")
    sts = ",".join(f"{k}x{v}" if v > 1 else str(k) for k, v in sorted(r["st"].items(), key=lambda kv: str(kv[0])))
    print(f"   {e_:10} {p_[:24]:24} {r['n']:>3} {sts[:10]:10} {','.join(sorted(r['ver']))[:9]:9} {np50:>7} {nmax:>4} | {bp50 if bp50 is not None else '-':>8} {bp99 if bp99 is not None else '-':>4} {len(b):>5}  {flag}")
print("   spans/entrypoints: " + ", ".join(f"{n} {'ok' if ok else 'MISSING'}" for n, ok in info["need"]))
warns += cpu_warn
for w in warns[:15]: print("   warn  " + w)
if early and missing:   # stopped on a definite error before ingest finished: what is still missing is not a finding
    print(f"   (stopped early on {len(fails)} error(s) after {waited:.0f}s; {len(missing)} items not yet ingested, not judged)"); missing = []
bad = fails + missing
for f in bad[:25]: print("   FAIL  " + f)
if len(bad) > 25: print(f"   … {len(bad) - 25} more")
if a.json:
    json.dump(dict(worker=a.worker, new=a.new, prev=PREV, run=a.run, waited_s=round(waited, 1), first_complete_s=first_complete,
                   expected=len(rays), seen=len({ray0(e) for e in front} & rays), fails=fails, missing=missing, warns=warns), open(a.json, "w"))
if bad:
    print(f"GATE FAILED: {len(fails)} errors, {len(missing)} missing ({a.worker} {a.new[:8]})"); sys.exit(1)
print(f"GATE ok: {a.worker} {a.new[:8]}, {len(rays)} smoke requests, 0 errors, {len(warns)} warnings, ingest {waited:.0f}s")
