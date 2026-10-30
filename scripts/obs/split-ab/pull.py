"""Pull one A/B run's server-side rows: python3 -I scripts/obs/split-ab/pull.py <tag> <run>   (windows from $AB_DIR/<tag>.windows.json)
Pull a run >= 5 min after it ends (ingest lag); tools run one at a time (parallel bursts hit the o11y 429 limit).
Writes runs/<tag>.<run>.<what>.json via the repo tools (queue.py, cold-split.py, cpu-by-version.py with --json) plus the
front-door spans (scan e2e, api.fetch hop) straight from telemetry.events_all."""
import json, os, subprocess, sys, collections
OBS = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."); sys.path.insert(0, OBS)
from telemetry import eq, events_all  # noqa: E402
from datetime import datetime
D = os.environ.get("AB_DIR", "ab-runs")
tag, run = sys.argv[1], sys.argv[2]
W = json.load(open(f"{D}/{tag}.windows.json")); w = next(x for x in W["windows"] if x["run"] == run)
F, T = w["from"], w["to"]
out = lambda what: f"{D}/{tag}.{run}.{what}.json"  # noqa: E731
def tool(args, what):
    if os.path.exists(out(what)): return
    r = subprocess.run(["python3", f"{OBS}/{args[0]}", "--from", F, "--to", T, *args[1:], "--json", out(what)], capture_output=True, text=True)
    open(out(what) + ".txt", "w").write(r.stdout + r.stderr)
    if r.returncode: raise SystemExit(f"{args} failed: {r.stderr[-500:]}")
jobs = [
    (["queue.py", "--path", "/v1/position"], "qpos"),
    (["queue.py", "--path", "/v1/alignment/search/window", "--service", "ephem-compute"], "qwin-S"),
    (["queue.py", "--path", "/v1/alignment/search/window", "--service", "ephem"], "qwin-E"),
    (["cold-split.py", "--route", "alignment/search/window", "--service", "ephem-compute"], "win-S"),
    (["cold-split.py", "--route", "alignment/search/window", "--service", "ephem"], "win-E"),
    (["cpu-by-version.py", "--path", "/v1/alignment/search"], "post"),
]
[tool(*j) for j in jobs]   # sequential: 6 tools x 8 slices in parallel hit the o11y 429 limit
if not os.path.exists(out("spans")):
    ms = lambda s: int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)  # noqa: E731
    win = (ms(F), ms(T)); by = collections.defaultdict(dict); hop = []
    for n in ["POST https://ephem.ivar.workers.dev/v1/alignment/search", "POST /v1/alignment/search /v1/alignment/search"]:
        for e in events_all([eq("$metadata.type", "span"), eq("$metadata.transactionName", n)], win):
            by[e["$metadata"]["traceId"]][n] = (e["$metadata"]["startTime"], e["$metadata"]["endTime"], e["source"].get("cloudflare", {}).get("script_version", {}).get("id", "")[:8])
    e2e = []
    for d in by.values():
        r, g = d.get("POST https://ephem.ivar.workers.dev/v1/alignment/search"), d.get("POST /v1/alignment/search /v1/alignment/search")
        if r and g: e2e.append(dict(version=r[2], e2e=g[1] - r[0], wait=g[0] - r[0]))
    for e in events_all([eq("$metadata.type", "span"), eq("$metadata.transactionName", "api.fetch")], win):
        s = e["source"]; hop.append(dict(version=s.get("cloudflare", {}).get("script_version", {}).get("id", "")[:8], cache=s.get("ephem", {}).get("api_cache"), ms=s.get("durationMS")))
    json.dump(dict(e2e=e2e, hop=hop), open(out("spans"), "w"))
print(run, "pulled")
