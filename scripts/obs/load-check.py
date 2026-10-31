"""Server side of an ephem-load run (guide "Load"): does the client see what ephem saw?

    python3 scripts/obs/load-check.py load-runs/<run id>.json [--json out.json]

Reads the run file load-remote.ts wrote (client percentiles per region and kind, plus up to 600 sampled [cf-ray, client ms,
status] per region and kind), then from Workers Observability:
  1. counts: front-door invocations carrying `x-ephem-load: <run>` per (route, answering colo, status, version), against the
     client's completed + prewarm requests (they should match to within ingest lag);
  2. per sampled request, joined on cf-ray: server e2e = end of the Effect request span - start of the runtime request span
     (the isolate's wait + the handler, no network) and the colo that ran it;
  3. per (region, kind): client p50/p90/p99 of the joined requests next to server e2e p50/p90/p99 of the same requests, and
     the per-request difference client - server (network + TLS + the generator's own scheduling): it should be small, >= 0,
     and alike across kinds within a region.
Pull >= 5 min after the run ends (ingest lag).
"""

import argparse
import collections
import json
import math
import os
import sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(__file__))
from telemetry import eq, events_all  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("run", help="load-runs/<run id>.json from load-remote.ts")
ap.add_argument("--json", help="write the joined rows (region, kind, ray, client, e2e, wait, colo) here")
a = ap.parse_args()
rep = json.load(open(a.run))
run = rep["runId"]
ms = lambda s: int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)  # noqa: E731
W = (
    ms(rep["window"].get("warmupAt", rep["window"]["startAt"])) - 15_000,
    ms(rep["window"]["endAt"]) + 45_000,
)  # prewarm before, timeouts after
H = "https://ephem.ivar.workers.dev"
ROUTES = {
    "position": [("GET", "/v1/position")],
    "warm": [("GET", "/v1/day"), ("GET", "/v1/track"), ("GET", "/v1/alignment")],
    "track": [("GET", "/v1/track")],
    "weather": [("GET", "/v1/weather")],
    "search": [("POST", "/v1/alignment/search")],
}


def pct(v, q):  # nearest rank, like the client histogram
    v = sorted(v)
    return v[max(0, math.ceil(q * len(v)) - 1)] if v else None


fmt = lambda x: "-" if x is None else f"{x:.0f}" if abs(x) >= 10 else f"{x:.1f}"  # noqa: E731

# 1. counts by the run's header
inv = events_all([eq("$metadata.type", "cf-worker-event"), eq("$workers.event.request.headers.x-ephem-load", run)], W)
cnt = collections.Counter()
cpu = collections.defaultdict(list)
for e in inv:
    w = e["$workers"]
    ev = w.get("event", {})
    path = ev.get("path") or ev.get("request", {}).get("url", "").split("?")[0].replace(H, "")
    cnt[
        (
            path,
            ev.get("request", {}).get("cf", {}).get("colo", "?"),
            ev.get("response", {}).get("status"),
            w["scriptVersion"]["id"][:8],
        )
    ] += 1
    cpu[path].append(w.get("cpuTimeMs", 0))
client_n = sum(s["completed"] for s in rep["totals"].values())
prewarm = sum(r["prewarm"]["sent"] + r.get("warmup", {}).get("sent", 0) for r in rep["regions"])
print(
    f"run {run} window {rep['window']['startAt']} .. {rep['window']['endAt']} (pinned {rep['spec'].get('pin') or 'no'})"
)
print(
    f"\n1. front-door invocations with x-ephem-load: {run}: {len(inv)}; client completed {client_n} + prewarm and warmup {prewarm} = {client_n + prewarm}"
    f" ({100 * len(inv) / max(1, client_n + prewarm):.1f}%)"
)
print(f"   {'route':22} {'colo':5} {'st':>4} {'version':9} {'n':>6}")
for (p, c, st, v), n in sorted(cnt.items(), key=lambda kv: (kv[0][0], -kv[1])):
    print(f"   {p:22} {c:5} {st!s:>4} {v:9} {n:>6}")
print(f"   {'route':22} {'cpu p50':>7} {'p99':>5}  (front-door invocation CPU, ms)")
for p, v in sorted(cpu.items()):
    print(f"   {p:22} {fmt(pct(v, 0.5)):>7} {fmt(pct(v, 0.99)):>5}")

# 2. spans of every route the run used, joined root -> Effect request span on traceId; keyed by ray
need = {r for k in rep["totals"] for r in ROUTES[k]}
by_ray = {}
for m, p in sorted(need):
    root, eff = f"{m} {H}{p}", f"{m} {p} {p}"
    roots = events_all([eq("$metadata.type", "span"), eq("$metadata.transactionName", root)], W)
    effs = {}
    # The front door's Effect span is "GET /v1/position /v1/position" for routes it serves and "GET /v1/track" for the ones its
    # Gateway forwards to the Api (the Api's own "GET /v1/track /v1/track" is in another trace, so the union is safe).
    for name in (eff, f"{m} {p}"):
        for e in events_all([eq("$metadata.type", "span"), eq("$metadata.transactionName", name)], W):
            effs.setdefault(e["$metadata"]["traceId"], e["$metadata"])
    for r in roots:
        md = r["$metadata"]
        g = effs.get(md["traceId"])
        if g and md.get("rayId"):
            by_ray[md["rayId"]] = dict(
                e2e=g["endTime"] - md["startTime"],
                wait=g["startTime"] - md["startTime"],
                colo=r["source"].get("cloudflare", {}).get("colo", "?"),
                route=p,
            )

# 3. client vs server for the same requests
rows = []
print(
    "\n2. client vs server, same requests (joined on cf-ray). client = generator fetch to last body byte; server e2e = runtime"
    "\n   request span start -> Effect request span end (isolate wait + handler). diff = client - server per request. ms."
)
hdr = f"   {'region':6} {'kind':8} {'joined':>9} {'client p50':>10} {'p90':>6} {'p99':>6} | {'server p50':>10} {'p90':>6} {'p99':>6} | {'diff p50':>8} {'p90':>6} {'<0':>4} | {'colo (server)':16} {'client table p50/p99':>20}"
print(hdr)
for reg in rep["regions"]:
    for kind, s in reg["kinds"].items():
        j = []
        for ray, cms, st, *at in s.get("sample") or []:  # [ray, client ms, status, sent at ms after the start]
            x = by_ray.get(ray.rsplit("-", 1)[0])
            if x:
                j.append((cms, x))
                rows.append(
                    dict(region=reg["region"], kind=kind, ray=ray, client=cms, status=st, at=at[0] if at else None, **x)
                )
        c = [x[0] for x in j]
        sv = [x[1]["e2e"] for x in j]
        d = [x[0] - x[1]["e2e"] for x in j]
        colos = collections.Counter(x[1]["colo"] for x in j).most_common(2)
        print(
            f"   {reg['region']:6} {kind:8} {len(j):>4}/{len(s.get('sample') or []):<4} {fmt(pct(c, 0.5)):>10} {fmt(pct(c, 0.9)):>6} {fmt(pct(c, 0.99)):>6} | "
            f"{fmt(pct(sv, 0.5)):>10} {fmt(pct(sv, 0.9)):>6} {fmt(pct(sv, 0.99)):>6} | {fmt(pct(d, 0.5)):>8} {fmt(pct(d, 0.9)):>6} {sum(1 for x in d if x < -2):>4} | "
            f"{', '.join(f'{k} {n}' for k, n in colos):16} {fmt(s['ms']['p50']) + '/' + fmt(s['ms']['p99']):>20}"
        )
if a.json:
    json.dump(rows, open(a.json, "w"))
slow = [r for r in rows if r["client"] - r["e2e"] > 200]
if slow:
    print(
        f"\n3. requests whose client time exceeds the server's by > 200 ms: {len(slow)} of {len(rows)} joined; by second after the start:"
    )
    by = collections.Counter((r["region"], (r["at"] or 0) // 1000) for r in slow)
    for reg in sorted({r["region"] for r in slow}):
        print(f"   {reg:6} " + ", ".join(f"{t}s x{n}" for (g, t), n in sorted(by.items()) if g == reg))
print(
    "\n(<0: requests whose client time is more than 2 ms under the server's: should be 0. The client table p50/p99 is over every"
    "\n request, the joined columns over the sample.)"
)
