"""Server-side wait before the handler ran, per request, from spans (no client network in it).

    python3 scripts/obs/queue.py --from 2026-10-30T19:03:30Z --to 2026-10-30T19:06:25Z [--path /v1/position] [--over 20]

queue = start of the Effect request span (the router began) − start of the runtime request span (the request reached the
isolate). A fresh isolate shows its start-up here (~70–230 ms); a request stuck behind another request's JS in a busy
isolate shows the wait. For live routes the row also says which: `blocks` / `geoid` cache L1 = this isolate already had
them (busy-isolate wait), HIT/MISS = it never loaded them (new isolate), plus ephem.isolate_computes and invocation CPU.
Paths: a front-door path (`/v1/position`), or `/v1/alignment/search/window` for Api window invocations.
"""
import argparse, collections, os, sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(__file__))
from telemetry import eq, events  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--from", dest="frm", required=True)
ap.add_argument("--to", required=True)
ap.add_argument("--path", default="/v1/position")
ap.add_argument("--over", type=float, default=20, help="list requests that waited longer than this (ms)")
ap.add_argument("--service", help="Worker: ephem (front door; default) or ephem-compute (Api, BlockStore since the compute split)")
a = ap.parse_args()
if a.service:
    import telemetry; telemetry.SERVICE = a.service
ms = lambda s: int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)  # noqa: E731
api = a.path == "/v1/alignment/search/window"
root = ("GET https://api.internal" if api else "GET https://ephem.ivar.workers.dev") + a.path
names = [root, f"GET {a.path} {a.path}", "blocks.load", "geoid.load", "position" if not api else "search.window"]
sp = collections.defaultdict(dict)
t0, t1 = ms(a.frm), ms(a.to)
for t in range(t0, t1, 10_000):   # the events view caps at 1000 rows per query
    for n in names:
        for e in events(0, [eq("$metadata.type", "span"), eq("$metadata.transactionName", n)], window=(t, min(t1, t + 10_000))):
            sp[e["$metadata"]["traceId"]].setdefault(n, e)
waits, slow = [], []
for d in sp.values():
    r, g = d.get(root), d.get(names[1])
    if not r or not g:
        continue
    w = g["$metadata"]["startTime"] - r["$metadata"]["startTime"]; waits.append(w)
    if w > a.over:
        at = lambda n, k: d.get(n, {}).get("source", {}).get("ephem", {}).get(k)  # noqa: E731
        slow.append((w, r["source"].get("cpu_time_ms"), at(names[4], "isolate_computes"), at("blocks.load", "blocks_cache"), at("geoid.load", "geoid_cache"), r["$metadata"].get("rayId")))
waits.sort()
p = lambda q: waits[min(len(waits) - 1, int(len(waits) * q))] if waits else None  # noqa: E731
print(f"{a.path} n={len(waits)} wait p50/p90/p99/max {p(.5)}/{p(.9)}/{p(.99)}/{waits[-1] if waits else None} ms; > {a.over:g} ms: {len(slow)} ({100 * len(slow) / max(1, len(waits)):.1f}%)")
for s in sorted(slow, key=lambda s: s[0], reverse=True)[:30]:
    kind = "new isolate" if s[3] and s[3] != "L1" else ("busy isolate" if s[3] == "L1" else "")
    print(f"  wait {s[0]:>4} ms  cpu {s[1]}  isolate_computes {s[2]}  blocks {s[3]}  geoid {s[4]}  {kind:12}  ray {s[5]}")
