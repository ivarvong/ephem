#!/usr/bin/env python3
"""Freeze oracle answers for the default cross-check cases into packages/core/test/fixtures/, and copy the DE440
blocks those cases need so the core test suite runs offline.

    python3 reference/oracle/fixtures.py --oracle http://127.0.0.1:8440
"""
import argparse, json, os, shutil, subprocess, sys, datetime as dt
sys.path.insert(0, os.path.dirname(__file__))
from crosscheck import default_cases, get

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
FIX = os.path.join(ROOT, "packages/core/test/fixtures"); os.makedirs(os.path.join(FIX, "blocks"), exist_ok=True)
REC, JD0, TT_UTC_MAX = 8144, 2287184.5, 70.0
URL = "https://ssd.jpl.nasa.gov/ftp/eph/planets/Linux/de440/linux_p1550p2650.440"
def jd(s): return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() / 86400 + 2440587.5
def blocks_between(j0, j1):
    a, b = int((j0 - 0.02 - JD0) // 32), int((j1 + 0.02 - JD0) // 32); return range(a, b + 1)

ap = argparse.ArgumentParser(); ap.add_argument("--oracle", default="http://127.0.0.1:8440"); a = ap.parse_args()
cases = default_cases(); need = set(); out = {"spec": "ephem-oracle/3", "position": [], "day": [], "crossing": [], "alignment": []}
for q in cases["position"]:
    s, r = get(a.oracle, "/v1/position", q); assert s == 200, (s, r); out["position"].append({"query": q, "expect": r})
    need.update(blocks_between(jd(q["time"]), jd(q["time"])))
for q in cases["day"]:
    s, r = get(a.oracle, "/v1/day", q); assert s == 200, (s, r); out["day"].append({"query": q, "expect": r})
    need.update(blocks_between(jd(r["start"]), jd(r["end"])))
for q in cases["crossing"]:
    s, r = get(a.oracle, "/v1/crossing", q); assert s == 200, (s, r); out["crossing"].append({"query": q, "expect": r})
    need.update(blocks_between(jd(r["start"]), jd(r["end"])))
for q in cases["alignment"]:
    s, r = get(a.oracle, "/v1/alignment", q); assert s == 200, (s, r); out["alignment"].append({"query": q, "expect": r})
    need.update(blocks_between(jd(q["start"]), jd(q["end"])))
for b in sorted(need):
    dst = os.path.join(FIX, "blocks", f"{b}.bin"); src = os.path.join(ROOT, "data/jpl/blocks", f"{b}.bin")
    if os.path.exists(dst): continue
    if not os.path.exists(src):
        os.makedirs(os.path.dirname(src), exist_ok=True); off = (2 + b) * REC
        subprocess.run(["curl", "-fsS", "-o", src, "-r", f"{off}-{off + REC - 1}", URL], check=True)
    shutil.copy(src, dst)
json.dump(out, open(os.path.join(FIX, "oracle.json"), "w"), indent=0, sort_keys=True)
print(len(out["position"]), "positions", len(out["day"]), "days", len(out["crossing"]), "crossings", len(out["alignment"]), "alignments", len(need), "blocks")
