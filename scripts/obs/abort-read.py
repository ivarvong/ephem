"""What an abort-probe run left in telemetry: per request, the invocation's outcome and status, the root span's status and
error, every span with an error or client.aborted, and every log line, with its level.

    python3 scripts/obs/abort-read.py <run id> [--minutes 15] [--json out.json]
"""
import argparse, json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import telemetry as t  # noqa: E402

ap = argparse.ArgumentParser(); ap.add_argument("run"); ap.add_argument("--minutes", type=float, default=15); ap.add_argument("--json")
a = ap.parse_args()
inv = t.events(a.minutes, [t.eq("$metadata.type", "cf-worker-event"), t.eq("$workers.event.request.headers.x-ephem-smoke", a.run)])
traces = sorted({e["$metadata"].get("traceId") for e in inv} - {None})
tev = [e for i in range(0, len(traces), 15) for e in t.events(a.minutes, [{"key": "$metadata.traceId", "operation": "in", "type": "string", "value": ",".join(traces[i:i + 15])}])]
out = []
for e in sorted(inv, key=lambda e: e["timestamp"]):
    w, m = e["$workers"], e["$metadata"]
    req = w["event"]["request"]
    row = dict(ray=m.get("rayId"), version=w.get("scriptVersion", {}).get("id", "")[:8], method=req.get("method"), path=req.get("url", "").split("ephem.ivar.workers.dev")[-1][:40],
               outcome=w.get("outcome"), status=(w["event"].get("response") or {}).get("status"), wall=w.get("wallTimeMs"), logs=[], spans=[])
    for x in tev:
        if x["$metadata"].get("traceId") != m.get("traceId"): continue
        xm, src = x["$metadata"], x.get("source") if isinstance(x.get("source"), dict) else {}
        if xm.get("type") == "cf-worker":
            row["logs"].append(f"{xm.get('level') or src.get('level') or '-'}: {json.dumps(src)[:150]}")
        elif xm.get("type") == "span":
            attrs = {k: v for k, v in (src.get("client") or {}).items() if k == "aborted"}
            if xm.get("level") == "error" or xm.get("error") or attrs or (src.get("ephem") or {}).get("outcome"):
                row["spans"].append(f"{xm.get('spanName')} level={xm.get('level')} status={xm.get('spanStatus')} error={xm.get('error')!r} "
                                    f"client.aborted={attrs.get('aborted')} ephem.outcome={(src.get('ephem') or {}).get('outcome')} outcome={(src.get('cloudflare') or {}).get('outcome')}")
    out.append(row)
    print(f"{row['method']} {row['path']} ray={row['ray']} ver={row['version']} outcome={row['outcome']} status={row['status']} wall={row['wall']}")
    for s in row["spans"]: print("   span " + s)
    for lg in row["logs"]: print("   log  " + lg)
print(f"{len(inv)} invocations, {len(tev)} trace events (run {a.run})")
if a.json: json.dump(out, open(a.json, "w"), indent=1)
