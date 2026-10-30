"""ephem-tail health and route labels from its own Workers Observability events (no Basin SQL token needed).

    python3 scripts/obs/tail-check.py [--minutes 10] [--version <uuid-or-prefix>] [--wait 90] [--require /v1/track,/llms.txt]

Counts ephem-tail invocations by (version, outcome) and sums the `tail_batch` log lines (one per tail() call:
{"tail_batch":{"rows":n,"routes":{"<entrypoint> <route>":count}}}) into route-label counts. --wait polls until the version
has at least one invocation with a tail_batch line (ingest lags 10-30 s). Exit 1 if: no invocation of the version, any
non-ok outcome or basin_send_failed line on it, or a --require'd route label is missing. deploy.sh runs it after a tail deploy.
"""
import argparse, collections, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import telemetry as t

ap = argparse.ArgumentParser()
ap.add_argument("--minutes", type=float, default=10); ap.add_argument("--version", default="")
ap.add_argument("--wait", type=float, default=0); ap.add_argument("--require", default="")
a = ap.parse_args()
t.SERVICE = "ephem-tail"
need = [r for r in a.require.split(",") if r]
deadline = time.time() + a.wait
while True:
    of = lambda e: e.get("$workers", {}).get("scriptVersion", {}).get("id", "").startswith(a.version)
    kind = lambda op: [{"key": "$metadata.type", "operation": op, "type": "string", "value": "cf-worker-event"}]
    inv = [e for e in t.events(a.minutes, kind("eq"), limit=1000) if of(e)]   # invocations and logs queried apart: 1000-row cap
    ev = [e for e in t.events(a.minutes, kind("neq"), limit=1000) if of(e)]
    batches = [e["source"]["tail_batch"] for e in ev if isinstance(e.get("source"), dict) and isinstance(e["source"].get("tail_batch"), dict)]
    labels = collections.Counter(); [labels.update(b.get("routes", {})) for b in batches]
    seen = {k.split(" ", 1)[1] for k in labels}
    if (batches and all(r in seen for r in need)) or time.time() >= deadline: break
    time.sleep(10)
outcomes = collections.Counter((e["$workers"]["scriptVersion"]["id"][:8], e["$workers"].get("outcome")) for e in inv)
fails = sum(1 for e in ev if isinstance(e.get("source"), dict) and "basin_send_failed" in e["source"])
print(f"ephem-tail, last {a.minutes:g} min{' version ' + a.version[:8] if a.version else ''}: {len(inv)} invocations, {len(batches)} tail_batch lines, {sum(b.get('rows', 0) for b in batches)} rows, {fails} basin_send_failed")
for (v, o), n in sorted(outcomes.items()): print(f"  invocations {v} {o}: {n}")
for k, n in sorted(labels.items(), key=lambda kv: (-kv[1], kv[0])): print(f"  {n:5d}  {k}")
bad = [f"no tail_batch line{' for ' + a.version[:8] if a.version else ''}"] if not batches else []
bad += [f"outcome {o} x{n}" for (v, o), n in outcomes.items() if o != "ok"] + ([f"{fails} basin_send_failed"] if fails else [])
bad += [f"route label {r} not seen" for r in need if r not in seen]
if bad: print("TAIL CHECK FAILED: " + "; ".join(bad)); sys.exit(1)
print("TAIL CHECK ok")
