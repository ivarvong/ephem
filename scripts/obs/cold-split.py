"""Api CPU by isolate warmth: per Api invocation of one route in a window, cpu/wall joined (traceId) to its handler span's
`ephem.isolate_computes` (1 = the isolate's first computation) and the blocks.load L1 count, and the gap from the runtime
GET span to the Effect GET span (isolate start-up before the router runs; real ms, it ends at I/O).

    python3 scripts/obs/cold-split.py --from 2026-10-30T11:25:30Z --to 2026-10-30T11:26:30Z [--route track] [--json out.json]

Versions without the attribute fall back to "L1 empty" as the cold proxy.
"""
import argparse, collections, json, os, sys
from datetime import datetime

sys.path.insert(0, os.path.dirname(__file__))
from telemetry import eq, events_all, starts  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--from", dest="frm", required=True); ap.add_argument("--to", required=True)
ap.add_argument("--route", default="track"); ap.add_argument("--json"); ap.add_argument("--version", help="script version id prefix")
a = ap.parse_args()
ms = lambda s: int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)  # noqa: E731
W = (ms(a.frm), ms(a.to))


def flat(d: dict, p: str = "") -> dict:
    out = {}
    for k, v in d.items():
        out.update(flat(v, p + k + ".") if isinstance(v, dict) else {p + k: v})
    return out


def spans(name: str) -> dict:
    out = collections.defaultdict(list)
    for s in events_all([eq("$metadata.type", "span"), eq("name", name)], W):   # slices, split at the 1000-row cap
        out[s["$metadata"]["traceId"]].append(flat(s["source"]))
    return out


inv = [e for e in events_all([eq("$metadata.type", "cf-worker-event"), starts("$workers.event.request.url", f"https://api.internal/{a.route}")], W)
       if not a.version or e["$workers"]["scriptVersion"]["id"].startswith(a.version)]
HANDLER = {"alignment/search/window": "search.window"}   # handler span name when it is not the route's
handler, loads, gets = spans(HANDLER.get(a.route, a.route)), spans("blocks.load"), spans("GET")
rows = []
for e in inv:
    tid, w = e["$metadata"]["traceId"], e["$workers"]
    h = (handler.get(tid) or [{}])[0]; b = (loads.get(tid) or [{}])[0]; g = gets.get(tid, [])
    rt = [s["startTime"] for s in g if "effect.span_id" not in s]; ef = [s["startTime"] for s in g if "effect.span_id" in s]
    rows.append(dict(version=w["scriptVersion"]["id"][:8], cpu=w.get("cpuTimeMs", 0), wall=w.get("wallTimeMs", 0), trace=tid, ray=e["$metadata"].get("rayId"),
                     seq=h.get("ephem.isolate_computes"), l1=b.get("cache.l1"), gap=(min(ef) - min(rt)) if rt and ef else None))
if a.json:
    json.dump(rows, open(a.json, "w"))


def pct(v, p):
    v = sorted(x for x in v if x is not None); return v[min(len(v) - 1, int(len(v) * p))] if v else "-"


def bucket(r):
    if r["seq"] is not None:
        s = r["seq"]; return "1 (fresh isolate)" if s == 1 else "2-5" if s <= 5 else "6-20" if s <= 20 else ">20"
    return "L1 empty (proxy)" if r["l1"] == 0 else "L1 hit (proxy)" if r["l1"] else "unknown"


print(f"{'version':9} {'isolate computes':18} {'n':>5}  {'cpu p50':>7} {'p90':>4} {'p99':>4}  {'cpu sum':>7}  {'pre-router gap p50':>18} {'p90':>4}")
g = collections.defaultdict(list)
for r in rows:
    g[(r["version"], bucket(r))].append(r)
for (v, k), rs in sorted(g.items()):
    c = [r["cpu"] for r in rs]; gp = [r["gap"] for r in rs]
    print(f"{v:9} {k:18} {len(rs):>5}  {pct(c,.5):>7} {pct(c,.9):>4} {pct(c,.99):>4}  {sum(c):>7}  {pct(gp,.5):>18} {pct(gp,.9):>4}")
for v in sorted({r["version"] for r in rows}):
    c = [r["cpu"] for r in rows if r["version"] == v]
    print(f"{v:9} {'all':18} {len(c):>5}  {pct(c,.5):>7} {pct(c,.9):>4} {pct(c,.99):>4}  {sum(c):>7}")
