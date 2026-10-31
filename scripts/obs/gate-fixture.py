"""Record a gate test fixture: every telemetry event (invocation, logs, spans) of the given rays, trimmed to what the gate
reads (no headers, no IP, no request.cf), as JSON for packages/worker/test/fixtures/gate/.

    python3 scripts/obs/gate-fixture.py <out.json> <ray> [<ray> ...] [--service ephem] [--minutes 60] [--note "why"]
"""
import argparse, json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import telemetry as t  # noqa: E402

ap = argparse.ArgumentParser(); ap.add_argument("out"); ap.add_argument("rays", nargs="+")
ap.add_argument("--service", default="ephem"); ap.add_argument("--minutes", type=float, default=60); ap.add_argument("--note", default="")
a = ap.parse_args()
KEEP_META = ("id", "rayId", "traceId", "spanId", "type", "level", "message", "error", "service", "spanName", "trigger", "timestampNs")


def trim(e):
    m = {k: v for k, v in e["$metadata"].items() if k in KEEP_META}
    out = {"$metadata": m, "timestamp": e.get("timestamp")}
    w = e.get("$workers")
    if isinstance(w, dict):
        ev = w.get("event") if isinstance(w.get("event"), dict) else {}
        rq = ev.get("request") or {}
        out["$workers"] = {k: w[k] for k in ("scriptVersion", "outcome", "entrypoint", "eventType", "wallTimeMs", "cpuTimeMs") if k in w}
        out["$workers"]["event"] = {"request": {k: rq[k] for k in ("method", "path") if k in rq} | ({"url": rq["url"].split("?")[0]} if "url" in rq else {}),
                                    **({"response": ev["response"]} if isinstance(ev.get("response"), dict) else {})}
    src = e.get("source")
    if isinstance(src, dict):
        if m.get("type") == "span":
            c = src.get("cloudflare") or {}
            out["source"] = {"cloudflare": {k: c[k] for k in ("ray_id", "outcome", "script_version") if k in c}, "url": {"path": (src.get("url") or {}).get("path", "")},
                             "http": {"response": ((src.get("http") or {}).get("response") or {})}, **{k: src[k] for k in ("client", "ephem") if k in src}}
        else:
            out["source"] = src
    return out


evs = []
for r in a.rays:
    first = t.events(a.minutes, [t.starts("$metadata.rayId", r)], service=a.service)
    traces = sorted({e["$metadata"].get("traceId") for e in first} - {None})
    evs += first + [e for tr in traces for e in t.events(a.minutes, [t.eq("$metadata.traceId", tr)], service=a.service)]
seen, keep = set(), []
for e in evs:
    k = json.dumps(e["$metadata"], sort_keys=True)
    if k not in seen: seen.add(k); keep.append(trim(e))
json.dump({"note": a.note, "service": a.service, "rays": a.rays, "events": keep}, open(a.out, "w"), indent=1)
print(f"{len(keep)} events → {a.out}")
