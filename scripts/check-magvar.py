"""Check ephem's WMM2025 declination (packages/core/src/wmm.ts) against FAA NASR airport magnetic variation.

    <venv>/bin/python -I scripts/check-magvar.py --nasr-zip <path/to/DD_Mon_YYYY_APT_CSV.zip> \
        [--metar <metars.cache.csv[.gz]>] [--csv <out.csv>] [--api https://ephem.ivar.workers.dev --api-sample 20]

Inputs (all explicit paths, read as data, never executed):
  --nasr-zip  the NASR 28-day APT CSV zip (nfdc.faa.gov/webContent/28DaySub/extra/<DD_Mon_YYYY>_APT_CSV.zip); APT_BASE.csv is
              read straight from the zip. Columns used: EFF_DATE ARPT_ID ICAO_ID SITE_TYPE_CODE STATE_CODE ARPT_NAME
              LAT_DECIMAL LONG_DECIMAL ELEV (ft MSL) MAG_VARN (whole degrees) MAG_HEMIS (E/W) MAG_VARN_YEAR.
  --metar     aviationweather.gov metars.cache.csv(.gz): its station_id set marks the airports our /v1/weather card can show.
Needs (in the Python env): numpy, ppigrf (bundles IGRF-14 IGRF14.shc, 1900-2030), pygeomag (bundles WMM_2025.COF, byte-identical
to NOAA's WMM.COF). `node` must be on PATH: our values come from packages/core/src/wmm.ts via --experimental-strip-types.

Comparisons (declination east-positive, degrees; NASR epoch = MAG_VARN_YEAR + --epoch-offset, default 0.0 = 1 January,
the convention that best reproduces NASR's 2025 rows: round-to-nearest of WMM2025 at Jan 1 matches 93.4% of them, cycle 2026-10-29):
  (a) MAG_VARN_YEAR >= 2025: ours at the NASR epoch - NASR (like for like; NASR is rounded to 1 deg). Epoch 2030 rows are
      WMM2025 projected to 2030.0, the end of its validity window.
  (b) older epochs: ours at the cycle date - NASR (secular drift), and IGRF-14 at the NASR epoch - NASR (like for like).
  (c) model cross-checks at the cycle date: ours - pygeomag WMM2025 (same model, independent code), ours - IGRF-14.
"""

import argparse
import csv
import datetime as dt
import gzip
import io
import json
import math
import os
import subprocess
import sys
import urllib.request
import zipfile

import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
WMM_TS = os.path.join(ROOT, "packages/core/src/wmm.ts")
FT_KM = 0.0003048
SPOT = [
    "KISP",
    "KJRB",
    "KNYC",
    "KLGA",
    "KJFK",
    "KEWR",
    "PABR",
    "PAFA",
    "PANC",
    "PADK",
    "PHNL",
    "PHTO",
    "PHOG",
    "TJSJ",
    "TJBQ",
    "TISX",
]


def decimal_year(d):
    y0, y1 = dt.datetime(d.year, 1, 1), dt.datetime(d.year + 1, 1, 1)
    return d.year + (d - y0).total_seconds() / (y1 - y0).total_seconds()


def read_nasr(zip_path):
    with zipfile.ZipFile(zip_path) as z, z.open("APT_BASE.csv") as f:
        rows = list(csv.DictReader(io.TextIOWrapper(f, encoding="latin-1")))
    out, eff = [], {r["EFF_DATE"] for r in rows}
    for r in rows:
        v, hem, yr = r["MAG_VARN"].strip(), r["MAG_HEMIS"].strip(), r["MAG_VARN_YEAR"].strip()
        out.append(
            {
                "id": r["ARPT_ID"].strip(),
                "icao": r["ICAO_ID"].strip(),
                "type": r["SITE_TYPE_CODE"].strip(),
                "state": r["STATE_CODE"].strip(),
                "name": r["ARPT_NAME"].strip(),
                "lat": float(r["LAT_DECIMAL"]),
                "lon": float(r["LONG_DECIMAL"]),
                "elev_ft": float(r["ELEV"] or 0),
                "status": r["ARPT_STATUS"].strip(),
                "nasr": (float(v) * (-1 if hem == "W" else 1)) if v and hem in ("E", "W") else None,
                "year": int(yr) if yr else None,
            }
        )
    return out, sorted(eff)


def metar_ids(path):
    op = gzip.open if path.endswith(".gz") else open
    with op(path, "rt", encoding="utf-8", errors="replace") as f:
        lines = list(f)
    # some captures of the feed carry preamble lines ("No errors", ...) before the header
    start = next(i for i, l in enumerate(lines) if l.startswith("raw_text,"))
    return {r["station_id"].strip() for r in csv.DictReader(lines[start:])}


def ours(points):
    """points: [[lat, lon, h_km, year], ...] -> declinations from packages/core/src/wmm.ts."""
    js = (
        "import { wmm } from %s; let s = ''; process.stdin.on('data', c => s += c).on('end', () => {"
        " const p = JSON.parse(s); process.stdout.write(JSON.stringify(p.map(([a, b, h, y]) => wmm(a, b, h, y).declination))) })"
    ) % json.dumps("file://" + WMM_TS)
    r = subprocess.run(
        ["node", "--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", js],
        input=json.dumps(points),
        capture_output=True,
        text=True,
        check=True,
    )
    return np.array(json.loads(r.stdout))


def igrf_decl(lat, lon, h_km, years):
    """IGRF-14 declination per point, each at its own decimal year (grouped by year for ppigrf)."""
    import ppigrf

    out = np.full(len(lat), np.nan)
    for y in np.unique(years):
        k = np.where(years == y)[0]
        yi = int(math.floor(y))
        frac = y - yi
        d = dt.datetime(yi, 1, 1) + (dt.datetime(yi + 1, 1, 1) - dt.datetime(yi, 1, 1)) * frac
        be, bn, _ = ppigrf.igrf(lon[k], lat[k], h_km[k], d)
        out[k] = np.degrees(np.arctan2(be[0], bn[0]))
    return out


def pygeomag_decl(lat, lon, h_km, year):
    from pygeomag import GeoMag
    from pygeomag.wmm.wmm_2025 import WMM_2025

    g = GeoMag(coefficients_data=WMM_2025)
    return np.array([g.calculate(glat=a, glon=b, alt=h, time=year).d for a, b, h in zip(lat, lon, h_km)])


def stats(d):
    a = np.abs(d)
    if not len(a):
        return "n=0"
    return (
        f"n={len(a):6d}  mean={np.mean(d):+.3f}  median|d|={np.median(a):.3f}  p95|d|={np.percentile(a, 95):.3f}  "
        f"max|d|={a.max():.3f}  |d|<=0.5: {100 * np.mean(a <= 0.5):5.1f}%  |d|<=1.0: {100 * np.mean(a <= 1.0):5.1f}%"
    )


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--nasr-zip", required=True)
    ap.add_argument("--metar")
    ap.add_argument("--csv", help="write the per-airport table here")
    ap.add_argument("--api", help="base URL; checks /v1/magnetic for a sample of airports against core")
    ap.add_argument("--api-sample", type=int, default=20)
    ap.add_argument("--epoch-offset", type=float, default=0.0, help="years added to MAG_VARN_YEAR (0 = 1 Jan)")
    a = ap.parse_args()

    rows, eff = read_nasr(a.nasr_zip)
    cyc = dt.datetime.strptime(eff[0], "%Y/%m/%d")
    t_now = decimal_year(cyc)
    print(f"NASR {os.path.basename(a.nasr_zip)}  EFF_DATE={eff}  rows={len(rows)}  cycle decimal year={t_now:.4f}")
    rows = [r for r in rows if r["nasr"] is not None and r["year"]]
    print(f"rows with MAG_VARN+MAG_HEMIS+MAG_VARN_YEAR: {len(rows)}")
    wx = metar_ids(a.metar) if a.metar else set()
    if a.metar:
        print(
            f"METAR stations in {os.path.basename(a.metar)}: {len(wx)}; NASR airports joined on ICAO_ID: {sum(r['icao'] in wx for r in rows)}"
        )

    lat = np.array([r["lat"] for r in rows])
    lon = np.array([r["lon"] for r in rows])
    h = np.array([r["elev_ft"] * FT_KM for r in rows])
    yr = np.array([r["year"] for r in rows])
    ep = yr + a.epoch_offset
    nasr = np.array([r["nasr"] for r in rows])
    met = np.array([r["icao"] in wx for r in rows])
    now = ours([[x, y, z, t_now] for x, y, z in zip(lat, lon, h)])
    recent = ep >= 2025.0
    at_ep = np.full(len(rows), np.nan)
    at_ep[recent] = ours([[x, y, z, t] for x, y, z, t in zip(lat[recent], lon[recent], h[recent], ep[recent])])
    ig_ep = igrf_decl(lat, lon, h, ep)
    ig_now = igrf_decl(lat, lon, h, np.full(len(rows), t_now))
    pg_now = pygeomag_decl(lat, lon, h, t_now)

    print("\n(c) model cross-checks at the cycle date, all airports")
    print(f"  ours - pygeomag WMM2025  {stats(now - pg_now)}")
    print(f"  ours - IGRF-14           {stats(now - ig_now)}")

    print("\n(a) MAG_VARN_YEAR >= 2025: ours at NASR epoch - NASR")
    for lab, m in (("all NASR", recent), ("METAR-joined", recent & met)):
        print(
            f"  {lab:14s} {stats((at_ep - nasr)[m])}  round(ours)==NASR: {100 * np.mean(np.round(at_ep[m]) == nasr[m]):.1f}%"
        )
        print(f"  {'  IGRF-14':14s} {stats((ig_ep - nasr)[m])}")

    print("\n(b) by NASR epoch decade: ours@cycle - NASR (drift)  |  IGRF-14@epoch - NASR (like for like)")
    dec = (yr // 10) * 10
    for lab, sel in (("all NASR", np.ones(len(rows), bool)), ("METAR-joined", met)):
        print(f"  {lab}")
        for d in np.unique(dec[sel]):
            m = sel & (dec == d)
            print(f"    {d}s  ours@cycle: {stats((now - nasr)[m])}")
            print(f"    {'':5s}  IGRF@epoch: {stats((ig_ep - nasr)[m])}")

    print("\n(a) rows where round(ours at epoch) != NASR, worst first")
    for i in sorted(
        np.where(recent & (np.round(np.nan_to_num(at_ep)) != nasr))[0], key=lambda j: -abs(at_ep[j] - nasr[j])
    ):
        r = rows[i]
        print(
            f"  {r['id']:5s} {r['icao']:5s} {r['state']:2s} {r['type']:1s} {r['lat']:9.4f} {r['lon']:10.4f} nasr {r['nasr']:+3.0f} {r['year']} ours {at_ep[i]:+7.2f} d {at_ep[i] - nasr[i]:+6.2f}  {r['name']}"
        )

    # outliers: like-for-like residual (ours at epoch for >= 2025, IGRF at epoch otherwise)
    lfl = np.where(recent, at_ep, ig_ep) - nasr
    print("\n10 worst like-for-like outliers (model at NASR epoch - NASR; model = ours if epoch >= 2025 else IGRF-14)")
    print(
        f"  {'id':5s} {'icao':5s} {'st':2s} {'t':1s} {'lat':>9s} {'lon':>10s} {'nasr':>5s} {'year':>4s} {'model@ep':>8s} {'d':>6s} {'ours@cyc':>8s}  name"
    )
    for i in np.argsort(-np.abs(lfl))[:10]:
        r = rows[i]
        print(
            f"  {r['id']:5s} {r['icao']:5s} {r['state']:2s} {r['type']:1s} {r['lat']:9.4f} {r['lon']:10.4f} {r['nasr']:+5.0f} {r['year']:4d} "
            f"{lfl[i] + nasr[i]:+8.2f} {lfl[i]:+6.2f} {now[i]:+8.2f}  {r['name']}"
        )
    print("\n10 worst outliers among METAR-joined airports")
    for i in [j for j in np.argsort(-np.abs(lfl)) if met[j]][:10]:
        r = rows[i]
        print(
            f"  {r['id']:5s} {r['icao']:5s} {r['state']:2s} {r['type']:1s} {r['lat']:9.4f} {r['lon']:10.4f} {r['nasr']:+5.0f} {r['year']:4d} "
            f"{lfl[i] + nasr[i]:+8.2f} {lfl[i]:+6.2f} {now[i]:+8.2f}  {r['name']}"
        )

    print(f"\nspot checks (ours and pygeomag at cycle {t_now:.3f}; ours@ep only when epoch >= 2025)")
    by = {}
    for i, r in enumerate(rows):
        by.setdefault(r["icao"], i)
        by.setdefault("K" + r["id"], i)
    print(
        f"  {'icao':5s} {'id':4s} {'nasr':>5s} {'year':>4s} {'ours@ep':>7s} {'IGRF@ep':>7s} {'ours@cyc':>8s} {'pygeomag':>8s} {'cyc-nasr':>8s}  name"
    )
    for s in SPOT:
        i = by.get(s)
        if i is None:
            print(f"  {s:5s} not in NASR APT_BASE (with mag var)")
            continue
        r = rows[i]
        e = f"{at_ep[i]:+7.2f}" if recent[i] else "    n/a"
        print(
            f"  {s:5s} {r['id']:4s} {r['nasr']:+5.0f} {r['year']:4d} {e} {ig_ep[i]:+7.2f} {now[i]:+8.2f} {pg_now[i]:+8.2f} {now[i] - nasr[i]:+8.2f}  {r['name']}"
        )

    if a.api:
        idx = np.linspace(0, len(rows) - 1, a.api_sample).astype(int)
        worst, today = 0.0, dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
        for i in idx:
            r = rows[i]
            u = f"{a.api}/v1/magnetic?lat={r['lat']}&lon={r['lon']}&height={r['elev_ft'] * 0.3048:.1f}"
            b = json.load(
                urllib.request.urlopen(
                    urllib.request.Request(u, headers={"user-agent": "ephem-check-magvar"}), timeout=20
                )
            )
            t = b.get("magnetic", {}).get("decimalYear") or b.get("decimalYear") or decimal_year(today)
            core = ours([[r["lat"], r["lon"], r["elev_ft"] * FT_KM, t]])[0]
            worst = max(worst, abs(b["magnetic"]["declination"] - core))
        print(f"\nAPI {a.api}/v1/magnetic vs core on {len(idx)} airports: max |api - core| = {worst:.2e} deg")

    if a.csv:
        with open(a.csv, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(
                [
                    "arpt_id",
                    "icao",
                    "state",
                    "site_type",
                    "lat",
                    "lon",
                    "elev_ft",
                    "nasr_decl",
                    "nasr_year",
                    "metar",
                    "ours_at_epoch",
                    "igrf_at_epoch",
                    "ours_at_cycle",
                    "pygeomag_at_cycle",
                    "igrf_at_cycle",
                    "name",
                ]
            )
            for i, r in enumerate(rows):
                w.writerow(
                    [
                        r["id"],
                        r["icao"],
                        r["state"],
                        r["type"],
                        r["lat"],
                        r["lon"],
                        r["elev_ft"],
                        r["nasr"],
                        r["year"],
                        int(met[i]),
                        "" if not recent[i] else f"{at_ep[i]:.4f}",
                        f"{ig_ep[i]:.4f}",
                        f"{now[i]:.4f}",
                        f"{pg_now[i]:.4f}",
                        f"{ig_now[i]:.4f}",
                        r["name"],
                    ]
                )
        print(f"wrote {a.csv}")


if __name__ == "__main__":
    main()
