#!/usr/bin/env python3
"""Cross-check two implementations of the @ephem/api contract, field by field.

    python3 reference/oracle/crosscheck.py --a http://127.0.0.1:8440 --b http://127.0.0.1:8787 [--cases cases.json]

Exits non-zero if any field differs by more than its tolerance or any event list differs in shape.
"""

import argparse
import datetime as dt
import json
import math
import os
import random
import sys
import urllib.parse
import urllib.request

# Tolerances: what "same answer" means between two correct implementations of the conventions.
TOL = {
    "angle_deg": 1e-4,  # 0.36″ — azimuth, altitudes, declination, ecliptic, phase angles
    "ra_hours": 1e-4 / 15,
    "distance_km": 0.01,
    "radius_deg": 1e-6,
    "fraction": 1e-6,
    "time_jd": 1e-9,  # 86 µs
    "seconds": 1e-6,
    "event_s": 0.5,  # rise/set/transit/twilight instants
    "align_m": 1.0,  # where-to-stand position
    "align_km": 0.001,
    "geoid_m": 0.01,  # horizon / dip / refraction-at-horizon use angle_deg: a few mm of geoid move the dip ~1e-5° at low heights            # PROJ float32 node vs the API's centimetre-rounded node, same 30′ bilinear
    "rate_deg_min": 1e-4,  # Skyfield's analytic rate vs the API's ±10 s symmetric difference
}
ANG = {
    "azimuth",
    "altitude",
    "apparentAltitude",
    "declination",
    "eclipticLongitude",
    "eclipticLatitude",
    "phaseAngle",
    "elongation",
    "brightLimbAngle",
}


def get(base, path, q):
    url = base.rstrip("/") + path + "?" + urllib.parse.urlencode(q)
    try:
        # Cloudflare's edge refuses Python-urllib's default User-Agent (error 1010) before the Worker runs.
        req = urllib.request.Request(
            url, headers={"user-agent": "ephem-crosscheck/1 (+reference/oracle/crosscheck.py)"}
        )
        with urllib.request.urlopen(req, timeout=600) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def angdiff(a, b):
    return abs(((a - b + 180) % 360) - 180)


def t_ms(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


class Report:
    def __init__(s):
        s.max = {}
        s.fail = []

    def check(s, key, diff, tol, ctx):
        m = s.max.get(key, (0.0, None))
        if diff > m[0]:
            s.max[key] = (diff, ctx)
        if not (diff <= tol):
            s.fail.append(f"{key}: |Δ| = {diff:.3g} > {tol:g}  [{ctx}]")

    def structural(s, msg):
        s.fail.append(msg)


def cmp_body(R, a, b, ctx, prefix):
    for k, va in a.items():
        vb = b.get(k)
        if k == "phase":
            cmp_body(R, va, vb, ctx, prefix + "phase.")
            continue
        if k == "name":
            (va == vb) or R.structural(f"{prefix}name {va!r} ≠ {vb!r} [{ctx}]")
            continue
        if va is None or vb is None:
            if (va is None) != (vb is None):
                R.structural(f"{prefix}{k} {va!r} vs {vb!r} (null in one only) [{ctx}]")
            continue
        if k in ("altitudeRate", "azimuthRate"):
            R.check(prefix + k, abs(va - vb), TOL["rate_deg_min"], ctx)
            continue
        if k in ANG:
            R.check(
                prefix + k,
                angdiff(va, vb)
                if k in ("azimuth", "eclipticLongitude", "elongation", "brightLimbAngle")
                else abs(va - vb),
                TOL["angle_deg"],
                ctx,
            )
        elif k == "rightAscension":
            R.check(prefix + k, abs(((va - vb + 12) % 24) - 12), TOL["ra_hours"], ctx)
        elif k == "distanceKm":
            R.check(prefix + k, abs(va - vb), TOL["distance_km"], ctx)
        elif k == "angularRadius":
            R.check(prefix + k, abs(va - vb), TOL["radius_deg"], ctx)
        elif k == "illuminatedFraction":
            R.check(prefix + k, abs(va - vb), TOL["fraction"], ctx)


def cmp_observer(R, a, b, ctx):
    for k in ("height", "heightEllipsoid", "heightMsl", "geoidUndulation"):
        if k in a and k in b:
            R.check("observer." + k, abs(a[k] - b[k]), TOL["geoid_m"], ctx)
    if a.get("heightRef") != b.get("heightRef"):
        R.structural(f"observer.heightRef {a.get('heightRef')} ≠ {b.get('heightRef')} [{ctx}]")


def cmp_num(R, key, va, vb, tol, ctx):
    if va is None or vb is None:
        if (va is None) != (vb is None):
            R.structural(f"{key}: {va!r} vs {vb!r} [{ctx}]")
        return
    R.check(key, abs(va - vb), tol, ctx)


def run_position(R, A, B, q):
    (sa, a), (sb, b) = get(A, "/v1/position", q), get(B, "/v1/position", q)
    ctx = f"position {q['time']} @{q['lat']},{q['lon']}"
    if sa != sb:
        return R.structural(f"status {sa} ≠ {sb} [{ctx}]")
    if sa != 200:
        return
    for k in ("jdTT", "jdUT1"):
        R.check("time." + k, abs(a["time"][k] - b["time"][k]), TOL["time_jd"], ctx)
    R.check("time.deltaT", abs(a["time"]["deltaT"] - b["time"]["deltaT"]), TOL["seconds"], ctx)
    cmp_body(R, a["sun"], b["sun"], ctx, "sun.")
    cmp_body(R, a["moon"], b["moon"], ctx, "moon.")
    if "conventions" in a and "conventions" in b:
        cmp_observer(R, a["observer"], b["observer"], ctx)
        ca, cb = a["conventions"], b["conventions"]
        cmp_num(R, "pos.horizon.altitude", ca["horizon"]["altitude"], cb["horizon"]["altitude"], TOL["angle_deg"], ctx)
        cmp_num(R, "pos.horizon.dip", ca["horizon"]["dip"], cb["horizon"]["dip"], TOL["angle_deg"], ctx)
        cmp_num(
            R,
            "pos.refraction.validFrom",
            ca["refraction"]["validFrom"],
            cb["refraction"]["validFrom"],
            TOL["angle_deg"],
            ctx,
        )


def run_day(R, A, B, q):
    (sa, a), (sb, b) = get(A, "/v1/day", q), get(B, "/v1/day", q)
    ctx = f"day {q['date']} {q['tz']} @{q['lat']},{q['lon']}"
    if sa != sb:
        return R.structural(f"status {sa} ≠ {sb} [{ctx}]")
    if sa != 200:
        return
    for k in ("start", "end"):
        R.check("day." + k, abs(t_ms(a[k]) - t_ms(b[k])), 1e-3, ctx)
    if "conventions" in a and "conventions" in b:
        cmp_observer(R, a["observer"], b["observer"], ctx)
        ra, rb = a["conventions"]["riseSet"], b["conventions"]["riseSet"]
        cmp_num(R, "day.horizon.altitude", ra["horizon"]["altitude"], rb["horizon"]["altitude"], TOL["angle_deg"], ctx)
        cmp_num(R, "day.horizon.dip", ra["horizon"]["dip"], rb["horizon"]["dip"], TOL["angle_deg"], ctx)
        cmp_num(
            R,
            "day.refraction.atHorizon",
            ra["refraction"]["atHorizon"],
            rb["refraction"]["atHorizon"],
            TOL["angle_deg"],
            ctx,
        )
        cmp_num(R, "day.trueLimbAltitude", ra["trueLimbAltitude"], rb["trueLimbAltitude"], TOL["angle_deg"], ctx)
        (ra["aim"]["point"] == rb["aim"]["point"]) or R.structural(f"aim {ra['aim']} ≠ {rb['aim']} [{ctx}]")
    ka = sorted((e["body"], e["kind"]) for e in a["events"])
    kb = sorted((e["body"], e["kind"]) for e in b["events"])
    if ka != kb:
        return R.structural(
            f"event sets differ [{ctx}]: only A {sorted(set(ka) - set(kb))}, only B {sorted(set(kb) - set(ka))}"
        )

    def key(e):
        return (e["body"], e["kind"])

    ga, gb = {}, {}
    for e in a["events"]:
        ga.setdefault(key(e), []).append(t_ms(e["time"]))
    for e in b["events"]:
        gb.setdefault(key(e), []).append(t_ms(e["time"]))
    for k in ga:
        for x, y in zip(sorted(ga[k]), sorted(gb[k])):
            R.check(f"event.{k[0]}.{k[1]}", abs(x - y), TOL["event_s"], ctx)


def run_crossing(R, A, B, q):
    (sa, a), (sb, b) = get(A, "/v1/crossing", q), get(B, "/v1/crossing", q)
    ctx = "crossing " + "&".join(f"{k}={v}" for k, v in q.items() if k not in ("lat", "lon"))
    if (sa == 200) != (sb == 200):
        return R.structural(f"status {sa} ≠ {sb} [{ctx}]")
    if sa != 200:
        return
    for k in ("start", "end"):
        R.check("crossing." + k, abs(t_ms(a[k]) - t_ms(b[k])), 1e-3, ctx)
    cmp_observer(R, a["observer"], b["observer"], ctx)
    cmp_num(
        R,
        "crossing.trueLimbAltitude",
        a["conventions"]["trueLimbAltitude"],
        b["conventions"]["trueLimbAltitude"],
        1e-9,
        ctx,
    )
    xa, xb = a["crossings"], b["crossings"]
    if [x["direction"] for x in xa] != [x["direction"] for x in xb]:
        return R.structural(
            f"crossing sequences differ [{ctx}]: {[x['direction'] for x in xa]} vs {[x['direction'] for x in xb]}"
        )
    for x, y in zip(xa, xb):
        R.check("crossing.time", abs(t_ms(x["time"]) - t_ms(y["time"])), TOL["event_s"], ctx)
        R.check(
            "crossing.azimuth", angdiff(x["azimuth"], y["azimuth"]), TOL["angle_deg"] * 10, ctx
        )  # at instants ≤ 0.5 s apart
        R.check("crossing.altitudeRate", abs(x["altitudeRate"] - y["altitudeRate"]), TOL["rate_deg_min"], ctx)


def run_rejects(R, A, B, q):
    """Both implementations refuse unknown or invalid parameters (any 4xx), never answer 200."""
    path = q.pop("_path")
    (sa, _), (sb, _) = get(A, path, q), get(B, path, q)
    ctx = f"reject {path} {q}"
    if not (400 <= sa < 500 and 400 <= sb < 500):
        R.structural(f"expected 4xx from both, got {sa} / {sb} [{ctx}]")
    else:
        R.check("reject.status_4xx", 0, 0, ctx)


def run_alignment(R, A, B, q):
    (sa, a), (sb, b) = get(A, "/v1/alignment", q), get(B, "/v1/alignment", q)
    ctx = f"alignment {q['body']} {q['start']}"
    if sa != sb:
        return R.structural(f"status {sa} ≠ {sb} [{ctx}]")
    if sa != 200:
        return
    ta = {p["time"]: p for p in a["track"]}
    tb = {p["time"]: p for p in b["track"]}
    if set(ta) != set(tb):
        return R.structural(
            f"track times differ [{ctx}]: only A {sorted(set(ta) - set(tb))[:3]}, only B {sorted(set(tb) - set(ta))[:3]}"
        )
    for t in ta:
        pa, pb = ta[t], tb[t]
        dlat = (pa["lat"] - pb["lat"]) * 111_132
        dlon = (pa["lon"] - pb["lon"]) * 111_320 * math.cos(math.radians(pa["lat"]))
        R.check("align.position_m", math.hypot(dlat, dlon), TOL["align_m"], f"{ctx} {t}")
        R.check("align.distanceKm", abs(pa["distanceKm"] - pb["distanceKm"]), TOL["align_km"], f"{ctx} {t}")
        R.check("align.azimuth", angdiff(pa["azimuth"], pb["azimuth"]), TOL["angle_deg"], f"{ctx} {t}")
        R.check(
            "align.apparentAltitude",
            abs(pa["apparentAltitude"] - pb["apparentAltitude"]),
            TOL["angle_deg"],
            f"{ctx} {t}",
        )
        if "heightEllipsoid" in pa and "heightEllipsoid" in pb:
            R.check(
                "align.heightEllipsoid_m",
                abs(pa["heightEllipsoid"] - pb["heightEllipsoid"]),
                TOL["align_m"],
                f"{ctx} {t}",
            )


OBS = [
    ("40.7127", "-74.0059", "-22.6", "America/New_York"),
    ("69.6492", "18.9553", "20", "Europe/Oslo"),
    ("-33.8568", "151.2153", "25", "Australia/Sydney"),
    ("-0.1807", "-78.4678", "2850", "America/Guayaquil"),
    ("64.1466", "-21.9426", "70", "Atlantic/Reykjavik"),
    ("21.3069", "-157.8583", "5", "Pacific/Honolulu"),
    ("39.108", "-76.771", "30", "America/New_York"),
]


def default_cases(seed=440):
    rnd = random.Random(seed)
    pos = []
    pos.append(dict(lat="40.7127", lon="-74.0059", height="-22.6", time="2026-10-28T11:51:00Z", dut1="0.0881733"))
    pos.append(dict(lat="39.108", lon="-76.771", height="30", time="1997-08-16T01:52:34Z"))
    for i in range(60):
        lat, lon, h, _ = OBS[i % len(OBS)]
        t = dt.datetime(1972, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(seconds=rnd.uniform(0, 178 * 365.25 * 86400))
        q = dict(lat=lat, lon=lon, height=h, time=t.strftime("%Y-%m-%dT%H:%M:%S.") + "%03dZ" % (t.microsecond // 1000))
        if i % 3 == 0:
            q.update(temperature=str(rnd.choice([-20, 0, 25, 35])), pressure=str(rnd.choice([700, 950, 1030])))
        if i % 4 == 0:
            q["dut1"] = "%.4f" % rnd.uniform(-0.9, 0.9)
        pos.append(q)
    days = []
    for lat, lon, h, tz in OBS[:6]:
        for d in (
            "2026-10-28",
            "2026-06-21",
            "2026-12-21",
            "2024-04-08",
            "2035-03-20",
            "2100-09-23",
            "1985-01-15",
            "2026-07-15",
        ):
            days.append(dict(lat=lat, lon=lon, height=h, date=d, tz=tz))
    # 2026-10-29 parameters: heights (ellipsoid / msl / default), horizon (sea / geometric / degrees), T/P on /v1/day, limbs, profiles
    NYC = dict(lat="40.7484", lon="-73.9857")
    for t in (
        "2026-10-29T21:55:00Z",
        "2026-10-29T22:00:00Z",
        "2026-10-29T22:04:00Z",
        "2026-10-29T22:10:00Z",
        "2026-10-30T05:00:00Z",
        "2026-10-29T11:20:00Z",
    ):
        for extra in (
            dict(),
            dict(height="0"),
            dict(height="320", heightRef="msl"),
            dict(height="320", heightRef="ellipsoid"),
            dict(height="320", heightRef="msl", horizon="geometric"),
            dict(height="320", heightRef="msl", horizon="-1.2"),
            dict(height="3000", heightRef="msl", temperature="-5", pressure="700"),
            dict(height="320", heightRef="msl", horizon="0.75", temperature="30", pressure="980"),
        ):
            pos.append(dict(NYC, time=t, **extra))
    for lat, lon, h, tz in ((OBS[1][0], OBS[1][1], "400", OBS[1][3]), (OBS[3][0], OBS[3][1], "2850", OBS[3][3])):
        for d in ("2026-12-21", "2026-06-21", "2026-10-28"):
            pos.append(dict(lat=lat, lon=lon, height=h, heightRef="msl", time=d + "T12:00:00Z"))
    PROF = "0:0.5,45:1.2,90:2.0,135:0.3,180:-0.2,225:0.9,270:3.5,300:1.0,330:0.2"
    for d in ("2026-10-29", "2026-06-21", "2026-12-21"):
        for extra in (
            dict(height="0"),
            dict(height="320", heightRef="msl"),
            dict(height="320", heightRef="msl", temperature="-20", pressure="1040"),
            dict(horizon="geometric"),
            dict(horizon="-0.5", aim="center"),
            dict(height="50", heightRef="msl", aim="lower"),
            dict(temperature="-20", pressure="1040"),
            dict(horizonProfile=PROF),
            dict(horizonProfile=PROF, aim="lower", height="20"),
        ):
            days.append(dict(NYC, date=d, tz="America/New_York", **extra))
    for extra in (dict(height="320", heightRef="msl"), dict(horizonProfile="170:1.0,190:0.5")):
        for d in ("2026-12-21", "2026-11-25", "2027-01-15"):
            days.append(
                dict(lat=OBS[1][0], lon=OBS[1][1], date=d, tz=OBS[1][3], **extra)
            )  # Tromsø: polar night, grazing Sun
    cross = []
    for extra in (
        dict(body="sun", altitude="-0.927", direction="set"),
        dict(body="sun", altitude="-0.833", altitudeType="apparent", aim="upper"),
        dict(body="sun", altitude="6", aim="lower"),
        dict(body="moon", altitude="0", altitudeType="apparent", aim="upper", height="320", heightRef="msl"),
        dict(body="sun", altitude="-18", direction="rise", temperature="-20", pressure="1040"),
        dict(body="sun", horizonProfile=PROF, aim="upper"),
        dict(body="moon", horizonProfile=PROF, aim="lower", direction="set"),
        dict(body="sun", altitude="-1.5", altitudeType="apparent"),
    ):
        cross.append(dict(NYC, date="2026-10-29", tz="America/New_York", **extra))
    cross.append(dict(NYC, body="sun", altitude="-6", start="2026-10-01T00:00:00Z", end="2026-10-31T00:00:00Z"))
    cross.append(
        dict(NYC, body="moon", altitude="10", aim="upper", start="2026-12-01T00:00:00Z", end="2026-12-08T00:00:00Z")
    )
    cross.append(
        dict(
            lat=OBS[1][0],
            lon=OBS[1][1],
            body="sun",
            altitude="-0.833",
            altitudeType="apparent",
            aim="upper",
            start="2026-11-20T00:00:00Z",
            end="2026-12-10T00:00:00Z",
        )
    )
    # 2026-10-31 correctness sweep: DST days, non-hour offsets, the date line, polar day and night, near-zenith, profile wraparound
    SWEEP_DAYS = [
        ("27.7172", "85.3240", "Asia/Kathmandu", ("2026-10-31", "2026-06-21")),  # UTC+5:45
        ("22.5726", "88.3639", "Asia/Kolkata", ("2026-12-21",)),  # UTC+5:30
        (
            "-43.9535",
            "-176.5597",
            "Pacific/Chatham",
            ("2026-09-27", "2027-04-04", "2026-11-15"),
        ),  # +12:45/+13:45, DST days
        ("40.7484", "-73.9857", "America/New_York", ("2026-03-08", "2026-11-01")),  # 23 h and 25 h days
        ("-31.5553", "159.0821", "Australia/Lord_Howe", ("2026-10-04", "2027-04-04")),  # 30-minute DST
        ("-33.4489", "-70.6693", "America/Santiago", ("2026-09-06", "2027-04-04")),  # DST at midnight
        ("51.4779", "-0.0015", "Europe/London", ("2026-03-29", "2026-10-25")),
        ("1.8721", "-157.4278", "Pacific/Kiritimati", ("2026-10-31",)),  # UTC+14, east of the date line
        ("-14.2756", "-170.7020", "Pacific/Pago_Pago", ("2026-10-31",)),  # UTC−11, just across it
        ("-16.8", "180", "Pacific/Fiji", ("2026-10-31",)),
        ("-16.8", "-180", "Pacific/Fiji", ("2026-10-31",)),  # on the 180th meridian
        (
            "78.2232",
            "15.6267",
            "Arctic/Longyearbyen",
            ("2026-06-21", "2026-12-21", "2026-04-19", "2026-08-24", "2026-10-26", "2027-02-16"),
        ),  # polar day/night edges
        ("-77.8463", "166.6683", "Antarctica/McMurdo", ("2026-12-21", "2026-06-21", "2026-10-24")),
        ("89.9", "0", "UTC", ("2026-03-20", "2026-09-23")),  # the pole at the equinoxes: one sunrise / sunset a year
        ("-14.3", "0", "UTC", ("2026-10-31",)),
        ("-0.1807", "-78.4678", "America/Guayaquil", ("2027-03-20",)),
    ]  # culminating near the zenith
    for lat, lon, tz, ds in SWEEP_DAYS:
        for d in ds:
            days.append(dict(lat=lat, lon=lon, date=d, tz=tz))
    WRAP = "120:1.5,240:0.5"  # one segment 240° → 120° through north: NYC's rise and set azimuths both fall in it
    for extra in (
        dict(horizonProfile=WRAP),
        dict(horizonProfile=WRAP, aim="lower"),
        dict(horizonProfile="350:2.5,10:0.5,180:1"),
    ):
        days.append(dict(NYC, date="2026-10-29", tz="America/New_York", **extra))
        days.append(
            dict(lat=OBS[1][0], lon=OBS[1][1], date="2027-05-25", tz=OBS[1][3], **extra)
        )  # Tromsø midnight Sun, due north
    # within ~0.3° of the zenith azimuth is ill-conditioned (8′ off: Δaz 2.4e-4° is 6e-7° on the sky), so not compared there
    for t in ("2026-10-31T11:40:00Z", "2026-10-31T11:42:00Z", "2026-10-31T11:46:00Z", "2026-10-31T11:50:00Z"):
        pos.append(dict(lat="-14.3", lon="0", time=t))
        pos.append(dict(lat="-14.3", lon="0", time=t, temperature="30", pressure="1000"))
    for lat, lon in (
        ("-16.8", "180"),
        ("-16.8", "-180"),
        ("-16.8", "179.9999"),
        ("89.9", "45"),
        ("-89.9", "-120"),
        ("90", "0"),
        ("-90", "0"),
    ):
        pos.append(dict(lat=lat, lon=lon, time="2026-10-31T06:00:00Z"))
    for extra in (
        dict(body="sun", altitude="89"),
        dict(body="sun", altitude="85", aim="lower"),
        dict(body="sun", altitude="80", altitudeType="apparent", aim="upper"),
    ):
        cross.append(dict(lat="-14.3", lon="0", date="2026-10-31", tz="UTC", **extra))
    for extra in (
        dict(body="sun", horizonProfile=WRAP),
        dict(body="moon", horizonProfile=WRAP, aim="upper"),
        dict(body="sun", horizonProfile=WRAP, aim="lower", direction="rise"),
    ):
        cross.append(dict(NYC, start="2026-10-25T00:00:00Z", end="2026-11-05T00:00:00Z", **extra))
    cross.append(
        dict(
            lat="27.7172",
            lon="85.3240",
            body="moon",
            altitude="-0.833",
            altitudeType="apparent",
            aim="upper",
            date="2026-10-31",
            tz="Asia/Kathmandu",
        )
    )
    cross.append(
        dict(
            lat="78.2232",
            lon="15.6267",
            body="sun",
            altitude="0",
            aim="upper",
            start="2026-04-01T00:00:00Z",
            end="2026-05-01T00:00:00Z",
        )
    )  # last sunsets before the midnight Sun
    days.append(dict(NYC, date="2026-11-16", tz="America/New_York", dut1="-0.4"))
    days.append(
        dict(
            lat="27.7172",
            lon="85.3240",
            date="2026-11-16",
            tz="Asia/Kathmandu",
            dut1="0.7",
            temperature="-5",
            pressure="900",
            height="1400",
            heightRef="msl",
        )
    )
    cross.append(
        dict(
            NYC,
            body="moon",
            altitude="5",
            dut1="0.5",
            temperature="30",
            pressure="990",
            date="2026-11-16",
            tz="America/New_York",
        )
    )
    rejects = [
        dict(NYC, _path="/v1/day", date="2026-10-29", tz="America/New_York", temprature="-20"),
        dict(NYC, _path="/v1/position", time="2026-10-29T21:55:00Z", bogus="1"),
        dict(
            NYC, _path="/v1/crossing", body="sun", date="2026-10-29", tz="America/New_York"
        ),  # neither altitude nor profile
        dict(
            NYC,
            _path="/v1/crossing",
            body="sun",
            altitude="-3",
            altitudeType="apparent",
            date="2026-10-29",
            tz="America/New_York",
        ),  # below the floor
        dict(NYC, _path="/v1/day", date="2026-10-29", tz="America/New_York", horizon="sea", horizonProfile="0:1"),
        dict(
            NYC, _path="/v1/day", date="2026-10-29", tz="America/New_York", height="5000", heightRef="msl"
        ),  # sea horizon below the floor
        dict(
            NYC, _path="/v1/day", date="2026-10-29", tz="America/New_York", limb="upper"
        ),  # renamed to aim (2026-10-31)
        dict(
            _path="/v1/alignment",
            body="moon",
            targetLat="40.68925",
            targetLon="-74.0445",
            targetHeight="70",
            observerHeight="5",
            start="2026-11-17T03:44:30Z",
            end="2026-11-17T03:46:00Z",
        ),
    ]  # observerHeight renamed to height
    align = [
        dict(
            body="moon",
            targetLat="40.68925",
            targetLon="-74.0445",
            targetHeight="63.4",
            height="-30.9",
            start="2026-10-28T23:45:00Z",
            end="2026-10-29T02:00:00Z",
            stepSeconds="900",
            maxDistanceKm="20",
        ),
        dict(
            body="sun",
            targetLat="40.748441",
            targetLon="-73.985664",
            targetHeight="410",
            height="-25",
            start="2026-10-28T20:00:00Z",
            end="2026-10-28T21:40:00Z",
            stepSeconds="600",
            maxDistanceKm="30",
        ),
        dict(
            body="moon",
            targetLat="40.68925",
            targetLon="-74.0445",
            targetHeight="70",
            targetHeightRef="msl",
            height="5",
            heightRef="msl",
            start="2026-11-17T03:44:30Z",
            end="2026-11-17T03:46:00Z",
            stepSeconds="30",
            maxDistanceKm="8",
            lat="40.7003",
            lon="-73.9968",
        ),
        dict(
            body="moon",
            targetLat="40.68925",
            targetLon="-74.0445",
            targetHeight="70",
            targetHeightRef="msl",
            start="2026-11-17T03:44:30Z",
            end="2026-11-17T03:46:00Z",
            stepSeconds="45",
            maxDistanceKm="8",
        ),
        dict(
            body="sun",
            targetLat="40.748441",
            targetLon="-73.985664",
            targetHeight="380",
            targetHeightRef="msl",
            height="2",
            heightRef="msl",
            start="2026-10-28T20:00:00Z",
            end="2026-10-28T21:40:00Z",
            stepSeconds="600",
            maxDistanceKm="30",
            temperature="-10",
            pressure="1030",
            dut1="0.3",
        ),
    ]
    return dict(position=pos, day=days, crossing=cross, alignment=align, reject=rejects)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--a", required=True)
    ap.add_argument("--b", required=True)
    ap.add_argument("--cases")
    ap.add_argument("--only", choices=["position", "day", "crossing", "alignment", "reject"])
    args = ap.parse_args()
    cases = json.load(open(args.cases)) if args.cases else default_cases()
    R = Report()
    for kind, fn in (
        ("position", run_position),
        ("day", run_day),
        ("crossing", run_crossing),
        ("alignment", run_alignment),
        ("reject", run_rejects),
    ):
        if args.only and args.only != kind:
            continue
        for q in cases.get(kind, []):
            fn(R, args.a, args.b, dict(q))
    w = max(len(k) for k in R.max) if R.max else 10
    print(f"{'field':{w}}  max |Δ|        worst case")
    for k, (v, ctx) in sorted(R.max.items()):
        print(f"{k:{w}}  {v:<13.4g}  {ctx}")
    print(f"\n{len(R.fail)} failures")
    for f in R.fail[:40]:
        print("  " + f)
    sys.exit(1 if R.fail else 0)
