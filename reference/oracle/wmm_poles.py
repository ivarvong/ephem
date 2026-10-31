#!/usr/bin/env python3
"""Freeze pygeomag (independent WMM2025 code, NOAA's WMM_2025.COF) near both geographic and both magnetic poles into
packages/core/test/fixtures/wmm2025/poles.json, for packages/core/test/wmm.test.ts. The official test values stop at |lat| 89°
and never sample the blackout zone; this grid covers lat ±80…±90 (90 exactly), every 30° of longitude, the dip poles, 3 epochs, 2 heights.

    <venv with pygeomag 1.1>/bin/python -I reference/oracle/wmm_poles.py
"""
import json, os
from pygeomag import GeoMag
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
g = GeoMag(coefficients_file="wmm/WMM_2025.COF")
pts = [(lat, lon) for lat in (90, 89.99, 89.9, 89.5, 88, 85, 80, -80, -85, -88, -89.5, -89.9, -89.99, -90) for lon in range(-180, 181, 30)]
pts += [(85.76, -139.3), (86.2, 150.0), (84.0, -120.0), (-63.8, 135.7), (-64.5, 137.0), (-62.0, 133.0)]   # near the 2025–2030 dip poles
rows = []
for year in (2025.0, 2026.826, 2029.99):
    for altKm in (0.0, 5.0):
        for lat, lon in pts:
            r = g.calculate(glat=lat, glon=lon, alt=altKm, time=year)
            rows.append(dict(year=year, altKm=altKm, lat=lat, lon=lon, d=r.d, i=r.i, h=r.h, f=r.f, x=r.x, y=r.y, z=r.z,
                             zone="blackout" if r.in_blackout_zone else "caution" if r.in_caution_zone else "ok"))
out = os.path.join(ROOT, "packages/core/test/fixtures/wmm2025/poles.json")
json.dump(dict(source="pygeomag 1.1.0, wmm/WMM_2025.COF (standard resolution)", rows=rows), open(out, "w"), indent=0)
print(len(rows), "rows,", sum(r["zone"] == "blackout" for r in rows), "blackout,", sum(r["zone"] == "caution" for r in rows), "caution ->", out)
