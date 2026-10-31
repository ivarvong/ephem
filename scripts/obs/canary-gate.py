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
--early F  pass as soon as there are 0 errors, every required entrypoint/span is visible and >= F of the smoke's requests are
           (prints "GATE ok (early …)"). Measured arrival (n=3, 2026-10-31): nothing for ~10 s, all 9 required signals at
           19-26 s with 76-80% coverage, 100% at 31-33 s. deploy.sh uses 0.75 before promotion and re-runs this check in
           full (no --early, --until <promotion>) in the background watcher, which rolls back if it fails.
--until    judge the new version's own events only before this instant (the deferred canary check runs after promotion)

Joins: front-door invocation (header x-ephem-smoke) → cf-ray → Api invocations (request header x-ephem-ray = front ray)
and BlockStore invocations (rayId starts with the front ray) on ephem →
traceIds → every span and log line of those traces. Plus every invocation and log line of <new-version> in the window
(at 0% only pinned requests reach it: the smoke, deploy.sh's /healthz polls).

FAIL on (rule; see docs/telemetry_and_profiling.md "Telemetry gate"):
  missing      at the deadline: coverage below --coverage (0.95) of the smoke's requests, a smoke check (route) with no
               front-door invocation at all, or a required entrypoint/span absent
  version      a smoke request answered by another version of <worker> than <new-version>
  outcome      any invocation with outcome other than ok / canceled
  5xx          any 5xx; or a front-door status that differs from what the client recorded
  error log    any log line at level error, any key ending in `_failed` (basin_send_failed, request_log_failed), any
               {"evt": "*_failed"}
  NOT a failure: a client abort (counted, one warning line): outcome `canceled`, the runtime's `Network connection lost.`
               exception on a request whose invocation shows no server error, {"evt": "client_aborted"}. The rules are
               scripts/obs/gate_rules.py, tested on recorded events (packages/worker/test/canary-gate.test.ts).
  live         an error of a signature (service, entrypoint, kind, path/evt) the previous version did not show in its
               baseline window; a signature the previous version also shows is a warning (pre-existing)
WARN only: CPU p50/max per (entrypoint, path) vs the previous version's last --baseline-min minutes: new p50 > 2x base p50
  and +5 ms, or new max > base p99 + 50 ms (base n >= 10). Not a failure: the smoke sends 1-3 requests per route to fresh
  isolates, whose first request pays isolate start-up (1.2-2x CPU), so the noise exceeds any rule we could
  defend at that n.
Exit 0 pass, 1 fail.
"""

import argparse
import collections
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

sys.path.insert(0, str(Path(__file__).parent))
import telemetry as t  # noqa: E402
from gate_rules import classify, is_err_log  # noqa: E402  the per-event rules (tested: packages/worker/test/canary-gate.test.ts)

ap = argparse.ArgumentParser()
ap.add_argument("worker", choices=["ephem"])
ap.add_argument("new")
ap.add_argument("prev")
ap.add_argument("--since", required=True)
ap.add_argument("--run", required=True)
ap.add_argument("--manifest", required=True)
ap.add_argument("--wait", type=float, default=90)
ap.add_argument("--live", type=float, default=0)
ap.add_argument("--baseline-min", type=float, default=15)
ap.add_argument("--json")
ap.add_argument(
    "--coverage", type=float, default=0.95, help="minimum share of the smoke's requests that must be visible"
)
ap.add_argument("--poll", type=float, default=0, help="seconds between polls (default 5; live 10)")
ap.add_argument(
    "--early",
    type=float,
    default=0,
    help="pass before full ingest once 0 errors, every required span/entrypoint, and this share of the smoke's requests are visible (deploy.sh: 0.75; it re-runs the full check after promotion)",
)
ap.add_argument(
    "--until",
    help="ISO: judge only the new version's own events before this (deploy.sh's deferred canary check: before promotion)",
)
a = ap.parse_args()
PREV = None if a.prev in ("", "-") else a.prev
ms = lambda s: int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)  # noqa: E731
iso = lambda m: datetime.fromtimestamp(m / 1000, timezone.utc).strftime("%H:%M:%S.%f")[:-5] + "Z"  # noqa: E731
T0 = ms(a.since) - 5_000  # clock skew between this laptop and the edge
COMPUTE_SVCS = ["ephem"]  # Api/BlockStore are ephem's own entrypoints
NOT_SPAN = {"key": "$metadata.type", "operation": "neq", "type": "string", "value": "span"}
INV = t.eq("$metadata.type", "cf-worker-event")
inn = lambda k, vs: {"key": k, "operation": "in", "type": "string", "value": ",".join(vs)}  # noqa: E731
chunks = lambda xs, n: [xs[i : i + n] for i in range(0, len(xs), n)]  # noqa: E731

man = []
for ln in Path(a.manifest).read_text().splitlines():
    p = ln.split()
    if len(p) >= 5 and p[0] not in ("", "-"):
        man.append(
            dict(ray=p[0].split("-")[0], status=int(p[1]) if p[1].isdigit() else 0, method=p[2], path=p[3], check=p[4])
        )
rays = {m["ray"] for m in man}
if not man:
    print("GATE FAILED: the manifest lists no requests (did the smoke run with --manifest?)")
    sys.exit(1)


def ver(e):
    return (e.get("$workers") or {}).get("scriptVersion", {}).get("id") or (e.get("source") or {}).get(
        "cloudflare", {}
    ).get("script_version", {}).get("id", "")


def ep(e):
    return (
        (e.get("$workers") or {}).get("entrypoint")
        or (e.get("source") or {}).get("cloudflare", {}).get("entrypoint")
        or "default"
    )


def svc(e):
    return e["$metadata"].get("service", "")


def req(e):
    ev = (e.get("$workers") or {}).get("event")
    return ev if isinstance(ev, dict) else {}


def status(e):
    return req(e).get("response", {}).get("status")


def path(e):
    return urlparse(req(e).get("request", {}).get("url", "")).path


def ray0(e):
    return (e["$metadata"].get("rayId") or "").split("-")[0]


def from_root_span(sp):
    """An invocation-shaped record from a runtime root span (fetch handler), for a request whose invocation event is lost."""
    c, src = sp["source"].get("cloudflare", {}), sp["source"]
    return {
        "$metadata": {
            "type": "cf-worker-event",
            "service": sp["$metadata"].get("service"),
            "rayId": c.get("ray_id"),
            "traceId": sp["$metadata"].get("traceId"),
            "from": "root span",
        },
        "$workers": {
            "scriptVersion": c.get("script_version", {}),
            "outcome": c.get("outcome"),
            "cpuTimeMs": src.get("cpu_time_ms", 0),
            "event": {
                "request": {"url": (src.get("url") or {}).get("full", "")},
                "response": {"status": ((src.get("http") or {}).get("response") or {}).get("status_code")},
            },
        },
    }


def par(fns):
    """Run thunks concurrently (each is one or more cf CLI queries, ~1 s apiece): a poll was ~10 sequential queries."""
    import threading

    res, errs = [None] * len(fns), []

    def run(i):
        try:
            res[i] = fns[i]()
        except BaseException as x:
            errs.append(x)  # noqa: B036 (SystemExit from a failed query must surface)

    ts = [threading.Thread(target=run, args=(i,)) for i in range(len(fns))]
    for th in ts:
        th.start()
    for th in ts:
        th.join()
    if errs:
        raise errs[0]
    return res


def collect(until: int):
    w = (T0, until)
    newsvc = "ephem"
    lw = (T0, max(until, T0 + 1)) if not a.live else (ms(a.since), until)
    if a.until:
        lw = (lw[0], min(lw[1], ms(a.until)))
    front, mine = par(
        [
            lambda: list(
                t.events_all([INV, t.eq("$workers.event.request.headers.x-ephem-smoke", a.run)], w, service="ephem")
            ),
            lambda: t.events_all([t.eq("$workers.scriptVersion.id", a.new), NOT_SPAN], lw, service=newsvc),
        ]
    )
    # Second, independent record of every request: the runtime's root span (cloudflare.ray_id, outcome, status, version,
    # cpu). An invocation event can be lost at ingest while its span arrives (1 of 154 smoke requests, 2026-10-30); such a
    # request still counts as visible, judged from its span.
    have = {ray0(e) for e in front}
    for sps in par(
        [
            lambda c=c: t.events(
                0, [t.eq("$metadata.type", "span"), inn("cloudflare.ray_id", c)], window=w, service="ephem"
            )
            for c in chunks(sorted(rays - have), 40)
        ]
    ):
        front += [from_root_span(sp) for sp in sps]
    fr = {ray0(e) for e in front}
    jobs = []
    for s in COMPUTE_SVCS:
        jobs += [
            lambda c=c, s=s: t.events(
                0, [INV, inn("$workers.event.request.headers.x-ephem-ray", c)], window=w, service=s
            )
            for c in chunks(sorted(fr), 40)
        ]
        jobs.append(
            lambda s=s: [
                e for e in t.events_all([INV, t.eq("$workers.entrypoint", "BlockStore")], w, service=s) if ray0(e) in fr
            ]
        )
    linked = [e for r in par(jobs) for e in r]
    traces = sorted({e["$metadata"].get("traceId") for e in front + linked} - {None})
    tev = [
        e
        for r in par(
            [
                lambda c=c: t.events(0, [inn("$metadata.traceId", c)], window=w, service="ephem")
                for c in chunks(traces, 15)
            ]
        )
        for e in r
    ]
    return front, linked, tev, mine


def judge(front, linked, tev, mine, final: bool):
    fails, warns, missing = [], [], []
    byray = collections.defaultdict(list)
    for e in front:
        byray[ray0(e)].append(e)
    # completeness and status agreement
    got = len(set(byray) & rays)
    if got < a.coverage * len(rays):
        missing.append(f"coverage {got}/{len(rays)} smoke requests visible, below {a.coverage:.0%}")
    for chk in sorted({m["check"] for m in man}):
        if not any(byray.get(m["ray"]) for m in man if m["check"] == chk):
            missing.append(f"no invocation or root span for check {chk}")
    for m in man:
        es = byray.get(m["ray"], [])
        if not es:
            continue
        st = status(es[0])
        if m["status"] and st != m["status"]:
            fails.append(f"status: {m['check']} {m['path']} server {st}, client saw {m['status']} (ray {m['ray']})")
    # version under test answered
    for e in front:
        if ver(e) != a.new:
            fails.append(f"version: {path(e)} answered by ephem {ver(e)[:8]} (ray {ray0(e)})")
    for e in linked:  # ctx.exports runs the caller's version: a forwarded MISS on another version is a routing bug
        if ver(e) != a.new:
            fails.append(f"version: {ep(e)} {path(e)} ran on {ver(e)[:8]} (ray {ray0(e)})")
    # outcomes, 5xx, error logs: the smoke's invocations, everything on their traces, everything the new version ran.
    # A client abort (outcome canceled, the runtime's "Network connection lost." on a request with no server error, our
    # client_aborted record) is counted, never failed: scripts/obs/gate_rules.py.
    errs, aborts = classify(front + linked + tev + mine, where=lambda e: f"{svc(e)}/{ep(e)} {ver(e)[:8]}", final=final)
    if aborts:
        warns.append(
            f"client aborts: {len(aborts)} ("
            + "; ".join(m for _, _, m in aborts[:3])
            + (" …" if len(aborts) > 3 else "")
            + ")"
        )
    key = lambda e: json.dumps(e["$metadata"], sort_keys=True)  # noqa: E731
    smoke_ids = {key(e) for e in front + linked + tev}
    for e, kind, msg in errs:
        if a.live and key(e) not in smoke_ids:  # real traffic: judge by signature against the previous version
            sig = (svc(e), ep(e), kind, path(e))
            if sig in BASE_SIGS:
                warns.append("live (pre-existing on prev): " + msg)
            else:
                fails.append("live: " + msg)
        else:
            fails.append(msg)
    # entrypoints and spans the smoke must have exercised
    spans = [e for e in tev if e["$metadata"].get("type") == "span"]
    names = collections.Counter((ep(e), e["$metadata"].get("spanName")) for e in spans)
    api = [e for e in linked if ep(e) == "Api"]
    bst = [e for e in linked if ep(e) == "BlockStore"]
    forced = [
        e
        for e in spans
        if e["$metadata"].get("spanName") == "blocks.load"
        and ep(e) == "Api"
        and "MISS" in str((e["source"].get("ephem") or {}).get("blocks_cache", ""))
    ]
    need = [
        ("default span GET", names[("default", "GET")] > 0),
        ("default span POST /mcp", names[("default", "POST")] > 0),
        ("default span api.fetch", names[("default", "api.fetch")] > 0),
        ("MCP span mcp.tools/call", names[("default", "mcp.tools/call")] > 0),
        ("MCP span mcp.initialize", names[("default", "mcp.initialize")] > 0),
        ("Api invocation", len(api) > 0),
        ("Api span position", names[("Api", "position")] > 0),
        ("Api span blocks.load", names[("Api", "blocks.load")] > 0),
        (f"BlockStore invocation ({len(forced)} forced MISS)", len(bst) > 0 or not forced),
    ]
    missing += [f"no {n}" for n, ok in need if not ok]
    return fails, warns, missing, dict(api=api, bst=bst, forced=forced, names=names, need=need)


def pct(v, p):
    v = sorted(v)
    return v[min(len(v) - 1, int(len(v) * p))] if v else None


BASE_SIGS, BASE = set(), collections.defaultdict(list)


def load_base():
    if not PREV:
        return
    bw = (ms(a.since) - int(a.baseline_min * 60_000), ms(a.since))
    bsvc = "ephem"
    for e in t.events_all([t.eq("$workers.scriptVersion.id", PREV), NOT_SPAN], bw, service=bsvc):
        if e["$metadata"].get("type") == "cf-worker-event":
            BASE[(ep(e), "/block/…" if ep(e) == "BlockStore" else path(e))].append(e["$workers"].get("cpuTimeMs", 0))
            o, st = e["$workers"].get("outcome"), status(e)
            if o and o not in ("ok", "canceled"):
                BASE_SIGS.add((svc(e), ep(e), f"outcome {o}", path(e)))
            if isinstance(st, int) and st >= 500:
                BASE_SIGS.add((svc(e), ep(e), f"status {st}", path(e)))
        else:
            m = is_err_log(e)
            if m:
                BASE_SIGS.add((svc(e), ep(e), "log " + m.split(":")[0], path(e)))


import threading  # noqa: E402  the baseline (a 15-min events_all) runs while the first polls do

BASE_T = threading.Thread(target=load_base)
BASE_T.start()

early = False
passed_early = None
start = time.time()
deadline = start + a.wait
live_end = ms(a.since) + int(a.live * 1000)
polls = 0
POLLS = []  # per poll: arrival of each signal (the measured arrival curve)
while True:
    polls += 1
    tq = time.time()
    front, linked, tev, mine = collect(int(time.time() * 1000))
    fails, warns, missing, info = judge(front, linked, tev, mine, False)
    logs = [e for e in tev + mine if e["$metadata"].get("type") == "cf-worker"]
    POLLS.append(
        dict(
            t=round(time.time() - start, 1),
            q=round(time.time() - tq, 1),
            cov=len({ray0(e) for e in front} & rays),
            of=len(rays),
            inv=sum(1 for e in front if e["$metadata"].get("from") != "root span"),
            linked=len(linked),
            tev=len(tev),
            logs=len(logs),
            mine=len(mine),
            need=sum(1 for _, ok in info["need"] if ok),
            needs=len(info["need"]),
            fails=len(fails),
        )
    )
    complete = not missing and len({ray0(e) for e in front} & rays) == len(
        rays
    )  # stop early only at 100%; floor applies at the deadline
    if a.live and fails:
        BASE_T.join()
        fails, warns, missing, info = judge(front, linked, tev, mine, False)  # live: signatures need the baseline
    if fails and not a.live:
        early = True
        break  # an error is definitive: no need to wait for the rest
    cov = len({ray0(e) for e in front} & rays) / len(rays)
    if a.early and not a.live and not fails and all(ok for _, ok in info["need"]) and cov >= a.early:
        passed_early = cov
        break
    if complete and (not a.live or time.time() * 1000 >= live_end + 15_000):
        break
    if time.time() >= deadline and (not a.live or time.time() * 1000 >= live_end + 15_000):
        break
    if polls == 1 or polls % 3 == 0:
        print(
            f"  gate: {len({ray0(e) for e in front} & rays)}/{len(rays)} smoke requests ingested, {len(missing)} missing, {time.time() - start:.0f}s",
            flush=True,
        )
    time.sleep(a.poll or (10 if a.live else 5))
waited = time.time() - start
first_complete = waited if complete else None
BASE_T.join()
fails, warns, missing, info = judge(
    front, linked, tev, mine, True
)  # CPU warnings need the baseline; a disconnect log still unjoined to its invocation is an error now

# --- table ---------------------------------------------------------------------------------------------------------------
under = "ephem (front door, Api, BlockStore)"
print(
    f"== telemetry gate: {a.worker} {a.new[:8]} vs {PREV[:8] if PREV else '-'} | run {a.run} | {under}{' | live ' + str(int(a.live)) + 's' if a.live else ''}"
)
nspan = sum(1 for e in front if e["$metadata"].get("from") == "root span")
print(
    f"   ingest: coverage {len({ray0(e) for e in front} & rays)}/{len(rays)} smoke requests visible after {waited:.0f}s ({polls} polls; floor {a.coverage:.0%}; {nspan} only by root span); "
    f"{len(info['api'])} Api + {len(info['bst'])} BlockStore invocations linked; {len(tev)} trace events; {len(mine)} events on {a.new[:8]}"
)
rows = collections.defaultdict(lambda: dict(n=0, st=collections.Counter(), cpu=[], ver=set()))
for e in front:
    r = rows[("default", path(e))]
    r["n"] += 1
    r["st"][status(e)] += 1
    r["cpu"].append(e["$workers"].get("cpuTimeMs", 0))
    r["ver"].add(ver(e)[:8])
for e in info["api"] + info["bst"]:
    r = rows[(ep(e), path(e) if ep(e) == "Api" else "/block/…")]
    r["n"] += 1
    r["st"][status(e)] += 1
    r["cpu"].append(e["$workers"].get("cpuTimeMs", 0))
    r["ver"].add(ver(e)[:8])
print(
    f"   {'entrypoint':10} {'path':24} {'n':>3} {'status':10} {'version':9} {'cpu p50':>7} {'max':>4} | {'prev p50':>8} {'p99':>4} {'n':>5}  cpu"
)
cpu_warn = []
judged = ("default", "Api", "BlockStore")  # one Worker: all of it is the version under test (CPU warnings only)
for (e_, p_), r in sorted(rows.items()):
    b = BASE.get((e_, p_), [])
    bp50, bp99 = pct(b, 0.5), pct(b, 0.99)
    np50, nmax = pct(r["cpu"], 0.5), max(r["cpu"])
    flag = ""
    if e_ in judged and len(b) >= 10:
        if np50 > 2 * bp50 and np50 - bp50 >= 5:
            flag = f"WARN p50 {np50} > 2x {bp50}"
        elif nmax > bp99 + 50:
            flag = f"WARN max {nmax} > p99 {bp99} + 50"
    elif e_ in judged:
        flag = "(base n<10)"
    if flag.startswith("WARN"):
        cpu_warn.append(f"cpu: {e_} {p_} {flag[5:]}")
    sts = ",".join(f"{k}x{v}" if v > 1 else str(k) for k, v in sorted(r["st"].items(), key=lambda kv: str(kv[0])))
    print(
        f"   {e_:10} {p_[:24]:24} {r['n']:>3} {sts[:10]:10} {','.join(sorted(r['ver']))[:9]:9} {np50:>7} {nmax:>4} | {bp50 if bp50 is not None else '-':>8} {bp99 if bp99 is not None else '-':>4} {len(b):>5}  {flag}"
    )
print("   spans/entrypoints: " + ", ".join(f"{n} {'ok' if ok else 'MISSING'}" for n, ok in info["need"]))
warns += cpu_warn
for w in warns[:15]:
    print("   warn  " + w)
if early and missing:  # stopped on a definite error before ingest finished: what is still missing is not a finding
    print(
        f"   (stopped early on {len(fails)} error(s) after {waited:.0f}s; {len(missing)} items not yet ingested, not judged)"
    )
    missing = []
if (
    passed_early is not None and not fails
):  # not-yet-ingested requests are not judged here: deploy.sh re-runs the full check
    print(
        f"   (passed early at {passed_early:.0%} coverage after {waited:.0f}s; {len(missing)} not-yet-ingested items left to the deferred full check)"
    )
    missing = []
bad = fails + missing
for f in bad[:25]:
    print("   FAIL  " + f)
if len(bad) > 25:
    print(f"   … {len(bad) - 25} more")
if a.json:
    json.dump(
        dict(
            worker=a.worker,
            new=a.new,
            prev=PREV,
            run=a.run,
            waited_s=round(waited, 1),
            first_complete_s=first_complete,
            expected=len(rays),
            seen=len({ray0(e) for e in front} & rays),
            fails=fails,
            missing=missing,
            warns=warns,
            polls=POLLS,
            early=passed_early,
        ),
        open(a.json, "w"),
    )
if bad:
    print(f"GATE FAILED: {len(fails)} errors, {len(missing)} missing ({a.worker} {a.new[:8]})")
    sys.exit(1)
early_s = (
    f" (early: {passed_early:.0%} of the requests visible, every required span; full check deferred)"
    if passed_early is not None
    else ""
)
print(
    f"GATE ok{early_s}: {a.worker} {a.new[:8]}, {len(rays)} smoke requests, 0 errors, {len(warns)} warnings, ingest {waited:.0f}s"
)
