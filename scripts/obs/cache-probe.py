"""Client-side cache probe: per-request cache status and latency, p50/p99 by (route, status). Cross-checks Workers Caching
from outside (HITs on a cache-enabled entrypoint never run it, so they leave no telemetry of their own).

    python3 scripts/obs/cache-probe.py [base] [--mode repeat|unique|burst] [--keys 10] [--repeats 5] [--burst 50] [--routes day,alignment,...]

  repeat  --keys fresh keys per route, each requested --repeats times in a row (1 cold + n-1 warm)
  unique  --keys fresh keys per route, each once (all cold)
  burst   --burst concurrent identical cold requests per route (request collapsing); prints the run id to find them in telemetry

Status per request: x-ephem-cache (the internal Api entrypoint's cf-cache-status, relayed by the front door), else
cf-cache-status, else "-". Latency is client wall (new TLS connection per request, like load.sh) and the front door's own
server-timing total. Every run prints a run id that is embedded in each key (the lat/lon/time jitter is derived from it).
"""
import argparse, collections, concurrent.futures as cf, random, string, time, urllib.request, urllib.error
from datetime import datetime, timedelta, timezone

ap = argparse.ArgumentParser()
ap.add_argument("base", nargs="?", default="https://ephem.ivar.workers.dev")
ap.add_argument("--mode", choices=["repeat", "unique", "burst"], default="repeat")
ap.add_argument("--keys", type=int, default=10)
ap.add_argument("--repeats", type=int, default=5)
ap.add_argument("--burst", type=int, default=50)
ap.add_argument("--parallel", type=int, default=8, help="concurrent keys in repeat/unique mode")
ap.add_argument("--routes", default="day,alignment,position,position-now,weather,weather-fixed,magnetic")
a = ap.parse_args()
run = "".join(random.choices(string.ascii_lowercase + string.digits, k=6))
rng = random.Random(run)


def iso(dt: datetime) -> str: return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def key(route: str) -> str:
    j = rng.random()
    lat, lon = round(20 + 40 * j, 5), round(-120 + 60 * rng.random(), 5)
    t = datetime(2030, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=rng.randrange(0, 3 * 365 * 86400))
    if route == "day": return f"/day?date={(t.date()).isoformat()}&tz=America/New_York&lat={lat}&lon={lon}"
    if route == "alignment": return f"/alignment?body=moon&targetLat=40.68925&targetLon=-74.0445&targetHeight=63.4&start={iso(t)}&end={iso(t + timedelta(hours=24))}"
    if route == "position": return f"/position?lat={lat}&lon={lon}&time={iso(t)}"
    if route == "position-now": return f"/position?lat={lat}&lon={lon}"
    if route == "weather": return f"/weather?lat={lat}&lon={lon}&n=3"
    if route == "weather-fixed": return "/weather?lat=40.7&lon=-74&n=3"   # one hot key: what SWR on the Api buys
    if route == "magnetic": return f"/magnetic?lat={lat}&lon={lon}"
    if route == "home": return "/"
    if route == "docs": return "/docs"
    raise SystemExit(f"unknown route {route}")


def get(path: str) -> tuple[str, int, str, float, float]:
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(urllib.request.Request(a.base + path, headers={"user-agent": f"ephem-cache-probe/{run}"}), timeout=30) as r:
            r.read(); st, h = r.status, r.headers
    except urllib.error.HTTPError as e:
        e.read(); st, h = e.code, e.headers
    ms = (time.perf_counter() - t0) * 1000
    status = h.get("x-ephem-cache") or h.get("cf-cache-status") or "-"
    stt = h.get("server-timing") or ""
    srv = float(stt.split("dur=")[1].split(",")[0]) if "dur=" in stt else float("nan")
    return path, st, status, ms, srv


rows = collections.defaultdict(lambda: ([], []))
order = collections.defaultdict(list)   # route -> status sequence per key (repeat mode)
routes = [r for r in a.routes.split(",") if r]
print(f"run {run} base {a.base} mode {a.mode}")
if a.mode == "burst":
    for route in routes:
        p = key(route)
        with cf.ThreadPoolExecutor(a.burst) as ex:
            res = list(ex.map(get, [p] * a.burst))
        for _, st, s, ms, srv in res: rows[(route, st, s)][0].append(ms); rows[(route, st, s)][1].append(srv)
        print(f"burst {route} {p}: " + ", ".join(f"{k}={v}" for k, v in collections.Counter(r[2] for r in res).items()))
else:
    reps = a.repeats if a.mode == "repeat" else 1

    def seq(route: str):
        p = key(route); out = []
        for _ in range(reps): out.append(get(p))
        return route, out
    with cf.ThreadPoolExecutor(a.parallel) as ex:
        for route, out in ex.map(seq, [r for r in routes for _ in range(a.keys)]):
            order[route].append("".join(s[2][:1] for s in out))
            for i, (_, st, s, ms, srv) in enumerate(out):
                tag = s if a.mode == "unique" else f"{s}{'' if i else ' (1st)'}"
                rows[(route, st, tag)][0].append(ms); rows[(route, st, tag)][1].append(srv)


def pct(v, p):
    v = sorted(x for x in v if x == x)
    return round(v[min(len(v) - 1, int(len(v) * p))], 1) if v else "-"


print(f"{'route':14} {'http':>4} {'cache':18} {'n':>4}  {'client p50':>10} {'p99':>6}  {'server p50':>10} {'p99':>6}")
for (route, st, s), (ms, srv) in sorted(rows.items()):
    print(f"{route:14} {st:>4} {s:18} {len(ms):>4}  {pct(ms, .5):>10} {pct(ms, .99):>6}  {pct(srv, .5):>10} {pct(srv, .99):>6}")
for route, seqs in order.items():
    print(f"sequence {route}: {' '.join(seqs)}")
