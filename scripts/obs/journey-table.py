#!/usr/bin/env python3
"""journey-table.py <dir> [prefix…]: one row per journey.ts model (<dir>/<name>.model.json), grouped by name without its last
"-<rep>": TTFB, FCP, LCP, data drawn, long tasks, requests during load (start <= data drawn) and after, document bytes,
total bytes (CDP encoded transfer), JS and CSS bytes. Medians per group, then every run. Numbers are recorded CDP values."""
import json, statistics, sys
from pathlib import Path

d = Path(sys.argv[1]); prefixes = sys.argv[2:]
rows = []
for f in sorted(d.glob("*.model.json")):
    name = f.name[:-len(".model.json")]
    if prefixes and not any(name.startswith(p) for p in prefixes): continue
    m = json.loads(f.read_text()); k = m["kpi"]; reqs = m["reqs"]; data = k.get("data")
    load = [r for r in reqs if data is not None and r["start"] <= data]
    after = [r for r in reqs if data is not None and r["start"] > data]
    b = lambda rs: sum(r.get("bytes") or 0 for r in rs)
    js = b([r for r in reqs if (r.get("path") or "").endswith(".js")]); css = b([r for r in reqs if (r.get("path") or "").endswith(".css")])
    doc = b([r for r in reqs if r.get("type") == "Document"])
    rows.append({"name": name, "group": name.rsplit("-", 1)[0], "ttfb": k.get("ttfb"), "fcp": k.get("fcp"), "lcp": k.get("lcp"), "data": data,
                 "longTasks": k.get("longTasks"), "longest": k.get("longestTask"), "reqLoad": len(load), "reqAfter": len(after), "doc": doc, "total": b(reqs), "js": js, "css": css})
cols = ["ttfb", "fcp", "lcp", "data", "longTasks", "longest", "reqLoad", "reqAfter", "doc", "total", "js", "css"]
fmt = lambda v: "–" if v is None else (f"{v:.0f}" if isinstance(v, float) else str(v))
print("| group | n | " + " | ".join(cols) + " |"); print("|" + "---|" * (len(cols) + 2))
groups = {}
for r in rows: groups.setdefault(r["group"], []).append(r)
for g, rs in groups.items():
    med = {c: statistics.median([r[c] for r in rs if r[c] is not None]) if any(r[c] is not None for r in rs) else None for c in cols}
    print(f"| {g} | {len(rs)} | " + " | ".join(fmt(med[c]) for c in cols) + " |")
print("\nruns:")
for r in rows: print("  " + r["name"].ljust(28) + " ".join(f"{c}={fmt(r[c])}" for c in cols))
