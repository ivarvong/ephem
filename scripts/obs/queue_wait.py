"""Server-side wait before the handler ran, per request, from spans (no client network in it).

    python3 scripts/obs/queue_wait.py --from 2026-10-30T19:03:30Z --to 2026-10-30T19:06:25Z [--path /v1/position] [--over 20]

queue = start of the Effect request span (the router began) − start of the runtime request span (the request reached the
isolate). A fresh isolate shows its start-up here (~70–230 ms); a request stuck behind another request's JS in a busy
isolate shows the wait. For live routes the row also says which: `blocks` / `geoid` cache L1 = this isolate already had
them (busy-isolate wait), HIT/MISS = it never loaded them (new isolate), plus ephem.isolate_computes and invocation CPU.
Paths: a front-door path (`/v1/position`), or `/internal/alignment-search-window` for Api window invocations.
"""
import argparse, collections, os, sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(__file__))
from telemetry import eq, events_all  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--from", dest="frm", required=True)
ap.add_argument("--to", required=True)
ap.add_argument("--path", default="/v1/position")
ap.add_argument("--over", type=float, default=20, help="list requests that waited longer than this (ms)")
ap.add_argument("--version", help="only requests served by this script version (id prefix)")
ap.add_argument("--json", help="write one row per request (wait, cpu, isolate_computes, kind, version, ray, start) here")
a = ap.parse_args()
ms = lambda s: int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)  # noqa: E731
api = a.path == "/internal/alignment-search-window"
root = ("GET https://api.internal" if api else "GET https://ephem.ivar.workers.dev") + a.path
names = [root, f"GET {a.path} {a.path}", "blocks.load", "geoid.load", "position" if not api else "search.window"]
sp = collections.defaultdict(dict)
t0, t1 = ms(a.frm), ms(a.to)
for n in names:   # events_all: 10 s slices, split further when a slice hits the 1000-row cap
    for e in events_all([eq("$metadata.type", "span"), eq("$metadata.transactionName", n)], (t0, t1)):
        sp[e["$metadata"]["traceId"]].setdefault(n, e)
waits, slow, rows = [], [], []
ver = lambda e: e.get("source", {}).get("cloudflare", {}).get("script_version", {}).get("id", "")  # noqa: E731
for d in sp.values():
    r, g = d.get(root), d.get(names[1])
    if not r or not g or (a.version and not ver(r).startswith(a.version)):
        continue
    w = g["$metadata"]["startTime"] - r["$metadata"]["startTime"]; waits.append(w)
    at = lambda n, k: d.get(n, {}).get("source", {}).get("ephem", {}).get(k)  # noqa: E731
    bc = at("blocks.load", "blocks_cache")
    rows.append(dict(wait=w, cpu=r["source"].get("cpu_time_ms"), isolate_computes=at(names[4], "isolate_computes"), blocks=bc,
                     kind="new isolate" if bc and bc != "L1" else "busy isolate" if bc == "L1" else "", version=ver(r)[:8],
                     ray=r["$metadata"].get("rayId"), start=r["$metadata"]["startTime"]))
    if w > a.over:
        slow.append((w, r["source"].get("cpu_time_ms"), at(names[4], "isolate_computes"), bc, at("geoid.load", "geoid_cache"), r["$metadata"].get("rayId")))
if a.json:
    import json; json.dump(rows, open(a.json, "w"))
waits.sort()
p = lambda q: waits[min(len(waits) - 1, int(len(waits) * q))] if waits else None  # noqa: E731
print(f"{a.path} n={len(waits)} wait p50/p90/p99/max {p(.5)}/{p(.9)}/{p(.99)}/{waits[-1] if waits else None} ms; > {a.over:g} ms: {len(slow)} ({100 * len(slow) / max(1, len(waits)):.1f}%)")
for s in sorted(slow, key=lambda s: s[0], reverse=True)[:30]:
    kind = "new isolate" if s[3] and s[3] != "L1" else ("busy isolate" if s[3] == "L1" else "")
    print(f"  wait {s[0]:>4} ms  cpu {s[1]}  isolate_computes {s[2]}  blocks {s[3]}  geoid {s[4]}  {kind:12}  ray {s[5]}")
