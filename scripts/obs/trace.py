"""Render one prod trace as a span tree with work-count attributes.

    python3 scripts/obs/trace.py <traceId> [--minutes 60]
    python3 scripts/obs/trace.py --latest /v1/alignment     # newest trace for a path
    python3 scripts/obs/trace.py --jsonrpc-id <run>-<step>  # the trace of one MCP message (mcp-probe.ts ids)

Workers emits every Effect span as a direct child of the request span; the tree is rebuilt from the
effect.span_id / effect.parent_id attributes that src/trace.ts sets.
"""
import argparse, os, sys
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(__file__))
from telemetry import eq, events, starts  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("trace", nargs="?")
ap.add_argument("--latest", metavar="PATH")
ap.add_argument("--jsonrpc-id", metavar="ID")
ap.add_argument("--minutes", type=float, default=60)
a = ap.parse_args()

if a.latest:
    # server-side prefix filter: an unfiltered pull of the newest events can miss a quiet path behind a busy one
    inv = [e for e in events(a.minutes, [eq("$metadata.type", "cf-worker-event"), starts("$workers.event.request.url", "https://ephem.ivar.workers.dev" + a.latest)], 200)
           if urlparse(e["$workers"].get("event", {}).get("request", {}).get("url", "")).path == a.latest]
    if not inv:
        raise SystemExit(f"no {a.latest} invocation in the last {a.minutes} min")
    a.trace = max(inv, key=lambda e: e["timestamp"])["$metadata"]["traceId"]
if a.jsonrpc_id:
    hit = events(a.minutes, [eq("jsonrpc.id", a.jsonrpc_id)], 5)
    if not hit:
        raise SystemExit(f"no span with jsonrpc.id={a.jsonrpc_id} in the last {a.minutes} min (ingest lags ~10–30 s)")
    a.trace = hit[0]["$metadata"]["traceId"]
if not a.trace:
    ap.error("give a traceId, --latest PATH or --jsonrpc-id ID")

evs = events(a.minutes, [eq("$metadata.traceId", a.trace)], 500)
if not evs:
    raise SystemExit(f"trace {a.trace} not found in the last {a.minutes} min (ingest lags ~10–30 s)")

INFRA = {"cloudflare", "faas", "cloud", "telemetry", "service", "scope", "traceId", "spanId", "parentSpanId", "name",
         "startTime", "endTime", "durationMS", "effect", "url", "server", "user_agent", "http"}


def flat(d: dict, p: str = "") -> dict:
    out = {}
    for k, v in d.items():
        if isinstance(v, dict):
            out.update(flat(v, p + k + "."))
        else:
            out[p + k] = v
    return out


inv = next((e for e in evs if e["$metadata"].get("type") == "cf-worker-event"), None)
spans = [e for e in evs if e["$metadata"].get("type") == "span"]
if inv:
    w = inv["$workers"]; ev = w.get("event", {})
    ray = next((s["source"]["cloudflare"]["ray_id"] for s in evs if s["source"].get("cloudflare", {}).get("ray_id")), "?")
    print(f"trace {a.trace}  version {w['scriptVersion']['id'][:8]}  ray {ray}")
    print(f"{ev.get('request', {}).get('url', '')}")
    print(f"status {ev.get('response', {}).get('status')}  wall {w.get('wallTimeMs')} ms  cpu {w.get('cpuTimeMs')} ms  outcome {w.get('outcome')}\n")

nodes = {}
for s in spans:
    src = s["source"]; eff = src.get("effect", {})
    nodes[s["$metadata"]["spanId"]] = dict(name=src.get("name"), ms=src.get("durationMS", 0), start=src.get("startTime", 0),
        eid=eff.get("span_id"), epar=eff.get("parent_id"), status=s["$metadata"].get("spanStatus") or "",
        attrs={k: v for k, v in flat({k: v for k, v in src.items() if k not in INFRA}).items()})
by_eid = {n["eid"]: n for n in nodes.values() if n["eid"]}
roots = [n for n in nodes.values() if not n["epar"] or n["epar"] not in by_eid]
kids = {}
for n in nodes.values():
    if n["epar"] in by_eid:
        kids.setdefault(n["epar"], []).append(n)
t0 = min((n["start"] for n in nodes.values()), default=0)


def show(n: dict, pre: str, last: bool, top: bool):
    br = "" if top else ("└─ " if last else "├─ ")
    attrs = "  ".join(f"{k}={str(v)[:60] + ('…' if len(str(v)) > 60 else '')}" for k, v in n["attrs"].items())
    print(f"{pre}{br}{n['name']:<{max(1, 22 - len(pre) - len(br))}} +{n['start'] - t0:>3}ms {n['ms']:>4}ms {n['status']:<3} {attrs}")
    cs = sorted(kids.get(n["eid"], []), key=lambda c: c["start"])
    for i, c in enumerate(cs):
        show(c, pre + ("" if top else ("   " if last else "│  ")), i == len(cs) - 1, False)


effect_roots = [r for r in roots if r["eid"]]; runtime = [r for r in roots if not r["eid"]]
print("Effect spans (src/trace.ts)")
for r in sorted(effect_roots, key=lambda n: n["start"]):
    show(r, "", True, True)
print("\nRuntime spans (workerd: request, Cache API, R2, fetch)")
for r in sorted(runtime, key=lambda n: n["start"]):
    show(r, "", True, True)
print("\n0 ms on compute spans is the frozen Workers clock, not zero work: read the work counts and the invocation cpu.")
