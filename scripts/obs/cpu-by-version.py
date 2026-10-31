"""CPU / wall percentiles per (version, entrypoint, path, status) from prod invocation events.

    python3 scripts/obs/cpu-by-version.py [--minutes 30] [--path /v1/alignment] [--version 80f5b087] [--from 2026-10-29T12:01:30Z --to 2026-10-29T12:03:00Z]

--path is also sent as a server-side filter, so the 1000-event cap applies per path rather than to all traffic.
entrypoint: `default` (the uncached front door), `Api`, `BlockStore`, `MetarFeed` (cached: a Workers Caching HIT never runs
them, so their n counts misses and revalidations). Loopback URLs are https://api.internal/…, https://blocks.internal/…,
https://feed.internal/…; with --entrypoint other than default, --path is matched client-side only (path prefix).
"""
import argparse, collections, os, sys
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(__file__))
from datetime import datetime  # noqa: E402
from telemetry import eq, events, events_all, starts  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--minutes", type=float, default=30)
ap.add_argument("--path", help="only this request path, e.g. /v1/alignment")
ap.add_argument("--version", help="only this script version (id prefix)")
ap.add_argument("--entrypoint", help="only this entrypoint: default, Api, BlockStore, MetarFeed")
ap.add_argument("--from", dest="frm", help="absolute window start, ISO-8601 (with --to)")
ap.add_argument("--to", help="absolute window end, ISO-8601")
ap.add_argument("--json", help="write one row per invocation (version, entrypoint, path, status, cpu, wall, ray, trace) here")
a = ap.parse_args()

rows = collections.defaultdict(lambda: ([], []))
ms = lambda s: int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)  # noqa: E731
window = (ms(a.frm), ms(a.to)) if a.frm and a.to else None
flt = [eq("$metadata.type", "cf-worker-event")]
if a.path and a.entrypoint in (None, "default"):
    flt.append(starts("$workers.event.request.url", "https://ephem.ivar.workers.dev" + a.path))
inv = events_all(flt, window) if window else events(a.minutes, flt)   # an absolute window is read in full (no 1000-row cap)
out = []
for e in inv:
    w = e["$workers"]
    ev = w.get("event") if isinstance(w.get("event"), dict) else {}
    path = urlparse(ev.get("request", {}).get("url", "")).path
    if a.path and not (path == a.path or (a.entrypoint not in (None, "default") and path.startswith(a.path))):
        continue
    ep = w.get("entrypoint") or "default"
    if a.entrypoint and ep != a.entrypoint:
        continue
    if a.version and not w["scriptVersion"]["id"].startswith(a.version):
        continue
    key = (w["scriptVersion"]["id"][:8], ep, path, ev.get("response", {}).get("status"))
    rows[key][0].append(w.get("cpuTimeMs", 0)); rows[key][1].append(w.get("wallTimeMs", 0))
    out.append(dict(version=key[0], entrypoint=ep, path=path, status=key[3], cpu=w.get("cpuTimeMs", 0), wall=w.get("wallTimeMs", 0),
                    ray=e["$metadata"].get("rayId"), trace=e["$metadata"].get("traceId"), url=ev.get("request", {}).get("url", ""),
                    start=e["$metadata"].get("startTime") or e.get("timestamp")))
if a.json:
    import json; json.dump(out, open(a.json, "w"))


def pct(v: list, p: float):
    v = sorted(v); return v[min(len(v) - 1, int(len(v) * p))]


print(f"{'version':9} {'entrypoint':10} {'path':16} {'st':>4} {'n':>5}  {'cpu p50':>7} {'p90':>4} {'p99':>4} {'cpu sum':>8}  {'wall p50':>8} {'p90':>4} {'p99':>4}")
for (ver, ep, path, st), (cpu, wall) in sorted(rows.items(), key=lambda kv: (kv[0][2][:9], kv[0][0], kv[0][1])):
    print(f"{ver:9} {ep:10} {path[:16]:16} {st!s:>4} {len(cpu):>5}  {pct(cpu,.5):>7} {pct(cpu,.9):>4} {pct(cpu,.99):>4} {sum(cpu):>8}  {pct(wall,.5):>8} {pct(wall,.9):>4} {pct(wall,.99):>4}")
print("(events view caps at 1000 rows per query: narrow --minutes or --path for busy windows)", file=sys.stderr)
