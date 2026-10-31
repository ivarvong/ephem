"""METAR feed cache: hit rate per tier, upstream calls per minute, and p50/p99 wall and CPU per tier, by version.

    python3 scripts/obs/metar-cache.py [--minutes 30] [--version 4febadbc] [--slice 2]

Joins the per-request log line {"evt":"metar","tier":…} (src/weather.ts, logged by the Api invocation that served
/weather) to its invocation event ($workers.wallTimeMs / cpuTimeMs) on $metadata.requestId. Tiers since the Workers
Caching rewrite are the MetarFeed loopback's cf-cache-status, lower-cased (hit / updating / stale / miss / expired /
revalidated) plus stale-on-error; before it (≤ 80f5b087) they were l1 / l1-stale / l2-* / origin*. Upstream calls are the
MetarFeed invocations' {"evt":"metar.upstream"} lines (src/metar-feed.ts); old versions logged {"evt":"metar.refresh"}.
The events view returns at most 1000 rows per query, so the window is fetched in --slice-minute slices; a slice that hits
1000 rows is reported (shrink --slice).
"""
import argparse, collections, json, os, subprocess, sys, time

sys.path.insert(0, os.path.dirname(__file__))
from telemetry import SERVICE, eq  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--minutes", type=float, default=30)
ap.add_argument("--slice", type=float, default=2, help="minutes per query (events view caps at 1000 rows)")
ap.add_argument("--version", help="only versions starting with this")
a = ap.parse_args()


def window(t0: int, t1: int, filters: list) -> list[dict]:
    body = {"queryId": "adhoc", "timeframe": {"from": t0, "to": t1}, "view": "events", "limit": 1000,
            "parameters": {"filters": [eq("$metadata.service", SERVICE), *filters]}}
    out = subprocess.run(["cf", "o11y", "telemetry", "query", "--body", json.dumps(body)], capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit(f"cf o11y telemetry query failed:\n{out.stderr or out.stdout}")
    ev = json.loads(out.stdout).get("events", {}).get("events", [])
    if len(ev) >= 1000:
        print(f"warning: slice {t0}..{t1} hit 1000 rows; counts are truncated (use a smaller --slice)", file=sys.stderr)
    return ev


now = int(time.time() * 1000); start = now - int(a.minutes * 60_000); step = int(a.slice * 60_000)
logs, inv = [], {}
for t0 in range(start, now, step):
    t1 = min(now, t0 + step)
    logs += window(t0, t1, [eq("$metadata.type", "cf-worker")])
    for e in window(t0, t1, [eq("$metadata.type", "cf-worker-event"), eq("$metadata.trigger", "GET /weather")]):
        inv[e["$metadata"].get("requestId")] = e["$workers"]


def ver(w: dict) -> str:
    return (w.get("scriptVersion") or {}).get("id", "?")[:8]


def pct(v: list, p: float):
    if not v: return "-"
    v = sorted(v); return round(v[min(len(v) - 1, int(len(v) * p))], 1)


req = collections.defaultdict(lambda: {"wall": [], "cpu": [], "n": 0, "parsed": 0, "age": []})
refresh = collections.Counter(); refresh_ms = collections.defaultdict(list); total = collections.Counter()
upstream = collections.Counter(); upstream_ms = collections.defaultdict(list); upstream_min = collections.Counter()
for e in logs:
    s, w = e.get("source") or {}, e.get("$workers") or {}
    if not isinstance(s, dict) or s.get("evt") not in ("metar", "metar.refresh", "metar.upstream"): continue
    v = ver(w)
    if a.version and not v.startswith(a.version): continue
    if s["evt"] == "metar.upstream":
        upstream[(v, s.get("status"), bool(s.get("conditional")))] += 1; upstream_ms[v].append(s.get("ms", 0))
        upstream_min[(v, int(e.get("timestamp", 0) // 60_000))] += 1; continue
    if s["evt"] == "metar.refresh":
        refresh[(v, s.get("trigger"), s.get("result"))] += 1; refresh_ms[(v, s.get("result"))].append(s.get("ms", 0)); continue
    r = req[(v, s.get("tier", "?"))]; r["n"] += 1; total[v] += 1; r["parsed"] += 1 if s.get("parsed") else 0; r["age"].append(s.get("dataAgeS", 0))
    i = inv.get(e["$metadata"].get("requestId"))
    if i: r["wall"].append(i.get("wallTimeMs", 0)); r["cpu"].append(i.get("cpuTimeMs", 0))

print(f"window: last {a.minutes:g} min ending {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now / 1000))}  (/weather requests with a metar log line)")
print(f"{'version':9} {'tier':15} {'n':>6} {'share':>6}  {'wall p50':>8} {'p99':>6}  {'cpu p50':>7} {'p99':>5}  {'parsed':>6} {'age p50':>7} {'max':>5}  joined")
for (v, tier), r in sorted(req.items(), key=lambda kv: (kv[0][0], -kv[1]["n"])):
    print(f"{v:9} {tier:15} {r['n']:>6} {100 * r['n'] / total[v]:>5.1f}%  {pct(r['wall'], .5):>8} {pct(r['wall'], .99):>6}  {pct(r['cpu'], .5):>7} {pct(r['cpu'], .99):>5}"
          f"  {r['parsed']:>6} {pct(r['age'], .5):>7} {max(r['age'] or [0]):>5}  {len(r['wall'])}/{r['n']}")
for v in sorted(total):
    hit = sum(r["n"] for (vv, t), r in req.items() if vv == v and t in ("l1", "l1-stale", "l2-fresh", "l2-stale", "hit", "updating", "stale", "stale-on-error"))
    print(f"{v}: {total[v]} requests, served without waiting on upstream {100 * hit / total[v]:.1f}%")
if refresh:
    print("\nbackground refreshes (waitUntil):")
    for (v, trig, res), n in sorted(refresh.items()):
        print(f"  {v} trigger={trig:9} result={res:11} n={n:<4} ms p50={pct(refresh_ms[(v, res)], .5)} p99={pct(refresh_ms[(v, res)], .99)}")
if upstream:
    print("\nupstream calls (MetarFeed invocations, {\"evt\":\"metar.upstream\"}):")
    for (v, st, cond), n in sorted(upstream.items()):
        print(f"  {v} status={st} conditional={cond!s:5} n={n}")
    for v in sorted({k[0] for k in upstream}):
        per = [n for (vv, _), n in upstream_min.items() if vv == v]
        span = max(1, len({m for (vv, m) in upstream_min if vv == v}))
        print(f"  {v}: {sum(per)} calls over {span} active minute(s), max {max(per)}/min, ms p50={pct(upstream_ms[v], .5)} p99={pct(upstream_ms[v], .99)}")
