#!/usr/bin/env python3
"""Skyfield oracle implementing the @ephem/api contract (reference/openapi.json).

Independent of @ephem/core: Skyfield 1.55 + JPL DE440s for astronomy, pyproj (Karney) for geodesy.
Run:  python3 reference/oracle/server.py --port 8440
"""
import argparse, json, math, os, re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs
import datetime as dt
from zoneinfo import ZoneInfo
import numpy as np
import pyproj
from pyproj import Geod, Transformer
from skyfield.api import load, wgs84
from skyfield import almanac
from skyfield.framelib import ecliptic_frame

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
EPH = load(os.path.join(ROOT, "reference/terrain_sunset/inputs/de440s.bsp"))
SUN, MOON, EARTH = EPH["sun"], EPH["moon"], EPH["earth"]
BASE_TS = load.timescale(builtin=True)
GEOD = Geod(ellps="WGS84")
PROV = dict(implementation="skyfield-oracle", version="skyfield 1.55", sources=["JPL DE440s"])
SUN_SD_1AU = 959.63 / 3600
MOON_RADIUS_KM = 1737.4
AU_KM = 149597870.7
UTC_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$")
K_TERR, R_MEAN = 0.13, 6371008.8

# ── heights: EGM96 through PROJ (cdn.proj.org's GeoTIFF of NGA's 15′ grid, read by pyproj), sampled at the 30′ nodes the API
#    defines, then this file's own bilinear. Independent of the API's data path (NGA ASCII grid → TS varints) and decoder. ──
pyproj.datadir.append_data_dir(os.path.join(ROOT, "reference/geoid/inputs")); pyproj.network.set_network_enabled(False)
_EGM96 = Transformer.from_crs("EPSG:4979", "EPSG:4326+5773", always_xy=True)
_NODE = {}
def _geoid_node(i, j):
    k = (i, j)
    if k not in _NODE:
        lat, lon = 90 - 0.5 * i, 0.5 * j
        lon = lon - 360 if lon > 180 else lon
        lat = max(-89.999999, min(89.999999, lat)) if abs(lat) == 90 else lat   # PROJ is undefined exactly at the poles
        _, _, H = _EGM96.transform(lon, lat, 0.0)
        if not math.isfinite(H): raise RuntimeError("EGM96 grid not found by PROJ: run reference/geoid/fetch.sh")
        _NODE[k] = -H
    return _NODE[k]
def geoid_n(lat, lon):
    y = min(max((90 - lat) / 0.5, 0.0), 360.0); i = min(int(math.floor(y)), 359); fy = y - i
    x = (lon % 360) / 0.5; j = int(math.floor(x)) % 720; fx = x - math.floor(x); j1 = (j + 1) % 720
    return (_geoid_node(i, j) * (1 - fy) * (1 - fx) + _geoid_node(i, j1) * (1 - fy) * fx
            + _geoid_node(i + 1, j) * fy * (1 - fx) + _geoid_node(i + 1, j1) * fy * fx)
def heights(q, lat, lon):
    N = geoid_n(lat, lon); ref = q.get("heightRef")
    if ref not in (None, "ellipsoid", "msl"): raise BadInput("heightRef must be ellipsoid or msl")
    if "height" not in q: return dict(heightEllipsoid=N, heightMsl=0.0, geoidUndulation=N, heightRef="default")
    h = fnum(q, "height", lo=-500, hi=100000)
    if ref == "msl": return dict(heightEllipsoid=h + N, heightMsl=h, geoidUndulation=N, heightRef="msl")
    return dict(heightEllipsoid=h, heightMsl=h - N, geoidUndulation=N, heightRef="ellipsoid")
def observer_out(lat, lon, hs): return dict(lat=lat, lon=lon, height=hs["heightEllipsoid"], **hs)

# ── horizon, dip, refraction (own code; the definitions are the contract's) ──
def sea_dip(h_msl): return 0.0 if h_msl <= 0 else math.degrees(math.sqrt(1 - K_TERR) * math.acos(R_MEAN / (R_MEAN + h_msl)))
FLOOR = math.sqrt(7.31) - 4.4
def horizon_of(q, h_msl):
    v = q.get("horizon", "sea")
    if v == "sea": d = sea_dip(h_msl); return dict(kind="sea", altitude=-d, dip=d)
    if v == "geometric": return dict(kind="geometric", altitude=0.0, dip=None)
    try: x = float(v)
    except ValueError: raise BadInput("horizon must be sea, geometric or degrees")
    if not (FLOOR - 1e-6 <= x <= 89): raise BadInput("horizon out of range")
    return dict(kind="custom", altitude=x, dip=None)
def _cot(a): return 1 / math.tan(math.radians(a + 7.31 / (a + 4.4)))
def refraction(a, T, P):
    """The contract's single model: Bennett's shape normalised to 34′ at 0° (10 °C, 1010 hPa), Bennett's P/T scaling;
    0 above 89.9° and below the floor. Written here from the contract text, not from core."""
    if a > 89.9 or a < FLOOR: return 0.0
    return (34 / 60) * (P / 1010) * (283 / (273 + T)) * _cot(a) / _cot(0.0)
def _solve(h, T, P):
    """a − R(a) = h on [FLOOR, 90] by bisection (core iterates a fixed point instead)."""
    a0, a1 = FLOOR, 90.0
    for _ in range(200):
        m = (a0 + a1) / 2
        if m - refraction(m, T, P) - h > 0: a1 = m
        else: a0 = m
    return (a0 + a1) / 2
def apparent_alt(h, T, P, lowest):
    lo = max(lowest, FLOOR)
    if lo - refraction(lo, T, P) > h: return None            # a − R(a) increases with a: the solution lies below lo
    a = _solve(h, T, P)
    return None if a < lo else a
def refract_true(h, T, P):
    """For /v1/alignment's geometry: the same model, no refraction where the solution would lie below the floor."""
    return h if h < FLOOR - refraction(FLOOR, T, P) else _solve(h, T, P)
rise_set_refraction = refraction
PROFILE_RE = re.compile(r"^-?\d+(\.\d+)?:-?\d+(\.\d+)?$")
def parse_profile(s):
    pts = [x.strip() for x in s.split(",") if x.strip()]
    if not 1 <= len(pts) <= 360: raise BadInput("horizonProfile needs 1-360 points")
    xy = []
    for p in pts:
        if not PROFILE_RE.match(p): raise BadInput("horizonProfile point is not az:el")
        az, el = map(float, p.split(":"))
        if not (0 <= az < 360) or not (FLOOR <= el <= 89): raise BadInput("horizonProfile point out of range")
        xy.append((az, el))
    xy.sort()
    if len({a for a, _ in xy}) != len(xy): raise BadInput("duplicate azimuth")
    return np.array([a for a, _ in xy]), np.array([e for _, e in xy])
def profile_at(prof, az):
    xp, fp = prof
    return float(fp[0]) if len(xp) == 1 else float(np.interp(az % 360, xp, fp, period=360))

class BadInput(Exception): pass

def timescale_with_dut1(dut1):
    """A Timescale whose UT1 is exactly UTC + dut1, i.e. ΔT = TT − UT1 = (TAI − UTC) + 32.184 − dut1."""
    ts = load.timescale(builtin=True)
    ts.delta_t_function = lambda tt: leap_offset(np.asarray(tt) - 32.184 / 86400) + 32.184 - dut1
    return ts

def leap_offset(tai_jd):
    """TAI − UTC (s) at a TAI Julian date. Skyfield's table: from UTC date leap_dates[i], TAI − UTC = leap_offsets[i]; 10 s before."""
    tai = np.atleast_1d(np.asarray(tai_jd, dtype=float))
    starts_tai = np.asarray(BASE_TS.leap_dates) + np.asarray(BASE_TS.leap_offsets) / 86400
    idx = np.searchsorted(starts_tai, tai, side="right") - 1
    out = np.where(idx >= 0, np.asarray(BASE_TS.leap_offsets, dtype=float)[np.clip(idx, 0, None)], 10.0)
    return out if np.ndim(tai_jd) else float(out[0])

def parse_utc(s):
    if not s or not UTC_RE.match(s): raise BadInput(f"time must be ISO-8601 UTC with Z: {s!r}")
    d = dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
    if not (dt.datetime(1972,1,1,tzinfo=dt.timezone.utc) <= d < dt.datetime(2150,1,1,tzinfo=dt.timezone.utc)): raise OutOfRangeErr(s)
    return d
class OutOfRangeErr(Exception): pass

def iso_ms(t):
    d = t.utc_datetime(); ms = int(round(d.microsecond / 1000))
    if ms == 1000: d = d.replace(microsecond=0) + dt.timedelta(seconds=1); ms = 0
    return d.strftime("%Y-%m-%dT%H:%M:%S") + ".%03dZ" % ms

def body_position(o, body, t, T, P, lowest=None, topo=None):
    """lowest=None: a number always (/v1/alignment's geometry); otherwise null below max(lowest, floor)."""
    app = o.at(t).observe(body).apparent()
    alt, az, dist = app.altaz()
    ra, dec, _ = app.radec(epoch="date")
    elat, elon, _ = EARTH.at(t).observe(body).apparent().frame_latlon(ecliptic_frame)
    rad = SUN_SD_1AU / (dist.km / AU_KM) if body is SUN else math.degrees(math.asin(MOON_RADIUS_KM / dist.km))
    aa = refract_true(alt.degrees, T, P) if lowest is None else apparent_alt(alt.degrees, T, P, lowest)
    out = dict(azimuth=az.degrees, altitude=alt.degrees, apparentAltitude=aa,
               rightAscension=ra.hours, declination=dec.degrees, distanceKm=dist.km, angularRadius=rad,
               eclipticLongitude=elon.degrees, eclipticLatitude=elat.degrees)
    if topo is not None:   # analytic rates from Skyfield's velocities (the API uses a ±10 s symmetric difference)
        r = app.frame_latlon_and_rates(topo)
        out.update(altitudeRate=float(r[3].degrees.per_minute), azimuthRate=float(r[4].degrees.per_minute))
    return out

PHASES = ["new", "waxing crescent", "first quarter", "waxing gibbous", "full", "waning gibbous", "last quarter", "waning crescent"]
def moon_phase(t):
    geo_s = EARTH.at(t).observe(SUN).apparent(); geo_m = EARTH.at(t).observe(MOON).apparent()
    a0, d0, _ = geo_s.radec(epoch="date"); a, d, _ = geo_m.radec(epoch="date")
    A0, D0, A, D = a0.radians, d0.radians, a.radians, d.radians
    chi = math.degrees(math.atan2(math.cos(D0) * math.sin(A0 - A), math.sin(D0) * math.cos(D) - math.cos(D0) * math.sin(D) * math.cos(A0 - A))) % 360
    elong = almanac.moon_phase(EPH, t).degrees
    return dict(phaseAngle=almanac.phase_angle(EPH, "moon", t).degrees, illuminatedFraction=float(almanac.fraction_illuminated(EPH, "moon", t)),
                elongation=elong, brightLimbAngle=chi, name=PHASES[int(((elong + 22.5) % 360) // 45)])

def fnum(q, k, default=None, lo=None, hi=None):
    if k not in q:
        if default is None: raise BadInput(f"missing {k}")
        return default
    try: v = float(q[k])
    except ValueError: raise BadInput(f"{k} is not a number")
    if not math.isfinite(v) or (lo is not None and v < lo) or (hi is not None and v > hi): raise BadInput(f"{k} out of range")
    return v

def position(q):
    lat, lon = fnum(q, "lat", lo=-90, hi=90), fnum(q, "lon", lo=-180, hi=180)
    T, P, dut1 = fnum(q, "temperature", 10.0, -90, 60), fnum(q, "pressure", 1010.0, 0, 1100), fnum(q, "dut1", 0.0, -0.9, 0.9)
    hs = heights(q, lat, lon); hz = horizon_of(q, hs["heightMsl"])
    d = parse_utc(q.get("time")); ts = timescale_with_dut1(dut1); t = ts.from_datetime(d)
    topo = wgs84.latlon(lat, lon, elevation_m=hs["heightEllipsoid"]); o = EARTH + topo
    moon = body_position(o, MOON, t, T, P, hz["altitude"], topo); moon["phase"] = moon_phase(t)
    return dict(time=dict(utc=q["time"], jdTT=t.tt, jdUT1=t.ut1, dut1=dut1, deltaT=float(t.delta_t)),
                observer=observer_out(lat, lon, hs), sun=body_position(o, SUN, t, T, P, hz["altitude"], topo), moon=moon,
                conventions=dict(horizon=dict(hz), refraction=dict(temperatureC=T, pressureHpa=P, validFrom=max(hz["altitude"], FLOOR))), provenance=PROV)

# ── day events ──
def _bisect(f, a, b, fa, tol_s=1e-4):
    while (b - a) * 86400 > tol_s:
        m = (a + b) / 2; fm = f(m)
        if (fm > 0) == (fa > 0): a, fa = m, fm
        else: b = m
    return (a + b) / 2
def _golden_min(g, a, b, tol_s=1e-4):
    r = (math.sqrt(5) - 1) / 2
    c, d = b - r * (b - a), a + r * (b - a); gc, gd = g(c), g(d)
    while (b - a) * 86400 > tol_s:
        if gc < gd: b, d, gd = d, c, gc; c = b - r * (b - a); gc = g(c)
        else: a, c, gc = c, d, gd; d = a + r * (b - a); gd = g(d)
    return (a + b) / 2
def _crossings(f, t0, t1, step_min=5.0):
    """All zero crossings of smooth f on [t0, t1]: sign changes between samples, plus grazing pairs (a local
    extremum between three samples that reaches across zero without a sign change at the samples)."""
    xs = list(np.arange(t0, t1, step_min / 1440)) + [t1]; v = [f(x) for x in xs]; out = []
    for i in range(len(xs) - 1):
        a, b, fa, fb = xs[i], xs[i + 1], v[i], v[i + 1]
        if (fa > 0) != (fb > 0): out.append((_bisect(f, a, b, fa), fa < fb)); continue
        if i + 2 >= len(xs): continue
        fn, c = v[i + 2], xs[i + 2]
        if abs(fb) < abs(fa) and abs(fb) < abs(fn) and (fb > 0) == (fa > 0) and (fn > 0) == (fa > 0):
            sgn = 1 if fa > 0 else -1
            ext = _golden_min(lambda x: sgn * f(x), a, c)
            if (f(ext) > 0) != (fa > 0):
                out.append((_bisect(f, a, ext, fa), fa < 0)); out.append((_bisect(f, ext, c, f(ext)), fa > 0))
    return sorted(out)

LIMB = {"upper": 1, "center": 0, "lower": -1}
def day(q):
    lat, lon = fnum(q, "lat", lo=-90, hi=90), fnum(q, "lon", lo=-180, hi=180)
    dut1 = fnum(q, "dut1", 0.0, -0.9, 0.9)
    T, P = fnum(q, "temperature", 10.0, -90, 60), fnum(q, "pressure", 1010.0, 0, 1100)
    hs = heights(q, lat, lon); limb = q.get("aim", "upper")
    if limb not in LIMB: raise BadInput("aim must be upper, center or lower")
    if "horizonProfile" in q:
        if "horizon" in q: raise BadInput("horizon or horizonProfile, not both")
        prof, hz = parse_profile(q["horizonProfile"]), None
    else:
        prof, hz = None, horizon_of(q, hs["heightMsl"])
        if hz["altitude"] < FLOOR: raise BadInput("horizon below the refraction floor")
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", q.get("date", "")): raise BadInput("date must be YYYY-MM-DD")
    try: Z = ZoneInfo(q.get("tz", ""))
    except Exception: raise BadInput("tz must be an IANA zone")
    y, m, dd = map(int, q["date"].split("-"))
    start = dt.datetime(y, m, dd, tzinfo=Z)
    end = dt.datetime(*(dt.date(y, m, dd) + dt.timedelta(days=1)).timetuple()[:3], tzinfo=Z)   # next local midnight
    ts = timescale_with_dut1(dut1); t0, t1 = ts.from_datetime(start).tt, ts.from_datetime(end).tt
    o = EARTH + wgs84.latlon(lat, lon, elevation_m=hs["heightEllipsoid"])
    def look(body, tt):
        a, z, d = o.at(ts.tt_jd(tt)).observe(body).apparent().altaz(); return a.degrees, z.degrees, d.km
    def radius(body, dkm): return SUN_SD_1AU / (dkm / AU_KM) if body is SUN else math.degrees(math.asin(MOON_RADIUS_KM / dkm))
    s_l = LIMB[limb]
    def rs(body):
        def f(tt):
            a, z, dkm = look(body, tt)
            H = profile_at(prof, z) if prof is not None else hz["altitude"]
            return a + s_l * radius(body, dkm) - (H - rise_set_refraction(H, T, P))
        return f
    ev = []
    for name, body in (("sun", SUN), ("moon", MOON)):
        for x, up in _crossings(rs(body), t0, t1):
            ev.append((x, name, "rise" if up else "set"))
        def sinha(tt):
            ha, _, _ = o.at(ts.tt_jd(tt)).observe(body).apparent().hadec(); return math.sin(ha.radians)
        for x, up in _crossings(sinha, t0, t1, 20):
            if up: ev.append((x, name, "transit"))
    for thr, dawn, dusk in ((-6, ("civilDawn", "blueHourEnd*"), ("civilDusk", "blueHourEnd")),
                            (-12, ("nauticalDawn",), ("nauticalDusk",)), (-18, ("astronomicalDawn",), ("astronomicalDusk",)),
                            (-4, ("blueHourEnd", "goldenHourStart"), ("goldenHourEnd", "blueHourStart")),
                            (6, ("goldenHourEnd",), ("goldenHourStart",))):
        for x, up in _crossings(lambda tt: look(SUN, tt)[0] - thr, t0, t1):
            for k in (dawn if up else dusk): ev.append((x, "sun", k))
    # −6° rising starts the morning blue hour; −6° setting ends the evening one.
    ev = [(x, b, "blueHourStart" if k == "blueHourEnd*" else k) for x, b, k in ev]
    ev.sort(key=lambda e: (e[0], e[1], e[2]))
    R = None if prof is not None else rise_set_refraction(hz["altitude"], T, P)
    conv = dict(riseSet=dict(aim=dict(point=limb), horizon=dict(hz) if hz else dict(kind="profile", altitude=None, dip=None),
                             refraction=dict(temperatureC=T, pressureHpa=P, atHorizon=R), trueLimbAltitude=None if R is None else hz["altitude"] - R),
                twilight=dict(civil=-6, nautical=-12, astronomical=-18), goldenHour={"from": -4, "to": 6}, blueHour={"from": -6, "to": -4})
    return dict(date=q["date"], tz=q["tz"], start=iso_ms(ts.tt_jd(t0)), end=iso_ms(ts.tt_jd(t1)), observer=observer_out(lat, lon, hs),
                events=[dict(time=iso_ms(ts.tt_jd(x)), body=b, kind=k) for x, b, k in ev], conventions=conv, provenance=PROV)

# ── crossing ──
def crossing(q):
    lat, lon = fnum(q, "lat", lo=-90, hi=90), fnum(q, "lon", lo=-180, hi=180)
    dut1 = fnum(q, "dut1", 0.0, -0.9, 0.9); T, P = fnum(q, "temperature", 10.0, -90, 60), fnum(q, "pressure", 1010.0, 0, 1100)
    hs = heights(q, lat, lon)
    body = q.get("body")
    if body not in ("sun", "moon"): raise BadInput("body must be sun or moon")
    B = SUN if body == "sun" else MOON
    limb = q.get("aim", "center"); direction = q.get("direction", "either")
    if limb not in LIMB or direction not in ("rise", "set", "either"): raise BadInput("bad aim or direction")
    if ("altitude" in q) == ("horizonProfile" in q): raise BadInput("altitude or horizonProfile")
    kind = q.get("altitudeType", "true")
    if kind not in ("true", "apparent"): raise BadInput("bad altitudeType")
    ts = timescale_with_dut1(dut1)
    if ("start" in q or "end" in q) == ("date" in q or "tz" in q): raise BadInput("start/end or date/tz")
    if "start" in q:
        s0, s1 = parse_utc(q.get("start")), parse_utc(q.get("end"))
        if not s1 > s0 or (s1 - s0).total_seconds() > 31 * 86400: raise BadInput("bad window")
    else:
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", q.get("date", "")): raise BadInput("date must be YYYY-MM-DD")
        try: Z = ZoneInfo(q.get("tz", ""))
        except Exception: raise BadInput("tz must be an IANA zone")
        y, m, dd = map(int, q["date"].split("-"))
        s0 = dt.datetime(y, m, dd, tzinfo=Z); s1 = dt.datetime(*(dt.date(y, m, dd) + dt.timedelta(days=1)).timetuple()[:3], tzinfo=Z)
    t0, t1 = ts.from_datetime(s0).tt, ts.from_datetime(s1).tt
    topo = wgs84.latlon(lat, lon, elevation_m=hs["heightEllipsoid"]); o = EARTH + topo
    s_l = LIMB[limb]
    def look(tt):
        a, z, d = o.at(ts.tt_jd(tt)).observe(B).apparent().altaz(); return a.degrees, z.degrees, d.km
    def radius(dkm): return SUN_SD_1AU / (dkm / AU_KM) if B is SUN else math.degrees(math.asin(MOON_RADIUS_KM / dkm))
    if "horizonProfile" in q:
        if "altitudeType" in q: raise BadInput("altitudeType goes with altitude")
        prof = parse_profile(q["horizonProfile"]); target = None
        def f(tt):
            a, z, dkm = look(tt); A = profile_at(prof, z); return a + s_l * radius(dkm) - (A - refraction(A, T, P))
    else:
        A = fnum(q, "altitude", lo=-90, hi=90)
        if kind == "apparent" and not (FLOOR <= A <= 89.9): raise BadInput("apparent altitude outside the refraction model")
        target = A if kind == "true" else A - refraction(A, T, P)
        def f(tt):
            a, _, dkm = look(tt); return a + s_l * radius(dkm) - target
    out = []
    for x, up in _crossings(f, t0, t1):
        if direction != "either" and (direction == "rise") != up: continue
        t = ts.tt_jd(x); p = body_position(o, B, t, T, P, None, topo)
        out.append(dict(time=iso_ms(t), direction="rise" if up else "set", azimuth=p["azimuth"], altitude=p["altitude"], altitudeRate=p["altitudeRate"]))
    return dict(body=body, start=iso_ms(ts.tt_jd(t0)), end=iso_ms(ts.tt_jd(t1)), observer=observer_out(lat, lon, hs), crossings=out,
                conventions=dict(aim=dict(point=limb), altitudeType="profile" if target is None else kind, trueLimbAltitude=target), provenance=PROV)

# ── alignment ──
def ecef(lat, lon, h):
    a, f = 6378137.0, 1 / 298.257223563; e2 = f * (2 - f); la, lo = math.radians(lat), math.radians(lon)
    N = a / math.sqrt(1 - e2 * math.sin(la) ** 2)
    return np.array([(N + h) * math.cos(la) * math.cos(lo), (N + h) * math.cos(la) * math.sin(lo), (N * (1 - e2) + h) * math.sin(la)])
def target_elevation(olat, olon, oh, tlat, tlon, th):
    O, T = ecef(olat, olon, oh), ecef(tlat, tlon, th); la, lo = math.radians(olat), math.radians(olon)
    up = np.array([math.cos(la) * math.cos(lo), math.cos(la) * math.sin(lo), math.sin(la)]); v = T - O
    geo = math.degrees(math.asin(np.dot(up, v) / np.linalg.norm(v)))
    _, _, dist = GEOD.inv(olon, olat, tlon, tlat)
    return geo + math.degrees(K_TERR * (dist / R_MEAN) / 2), dist

def standing_point(B, t, T, P, tlat, tlon, th, eye, maxd_m):
    """Solve P: body azimuth at P = forward azimuth P→target; body apparent altitude at P = target apparent elevation.
    eye(lat, lon): the eye's ellipsoidal height there (msl heights add the geoid at each candidate point)."""
    def look(lat, lon):
        p = body_position(EARTH + wgs84.latlon(lat, lon, elevation_m=eye(lat, lon)), B, t, T, P)
        return p["azimuth"], p["altitude"], p["apparentAltitude"], p["angularRadius"]
    olat, olon = tlat, tlon; back = None
    for it in range(1, 13):
        az, alt, app, rad = look(olat, olon)
        if alt < -1.0: return None
        if back is None: back = (az + 180) % 360
        def place(dm):
            lo2, la2, _ = GEOD.fwd(tlon, tlat, back, dm); return la2, lo2
        def g(dm):
            la2, lo2 = place(dm); el, _ = target_elevation(la2, lo2, eye(la2, lo2), tlat, tlon, th); return el - app
        lo_d, hi_d = 1.0, maxd_m
        if g(lo_d) < 0 or g(hi_d) > 0: return None
        while hi_d - lo_d > 1e-4:
            mid = (lo_d + hi_d) / 2
            if g(mid) > 0: lo_d = mid
            else: hi_d = mid
        la2, lo2 = place((lo_d + hi_d) / 2)
        fwd, _, _ = GEOD.inv(lo2, la2, tlon, tlat)
        d_az = ((az - fwd + 540) % 360) - 180
        _, _, moved = GEOD.inv(olon, olat, lo2, la2)
        olat, olon = la2, lo2
        if abs(d_az) < 1e-9 and moved < 1e-3: break
        back = (back + d_az) % 360
    _, _, dist = GEOD.inv(olon, olat, tlon, tlat)
    hE = eye(olat, olon); N = geoid_n(olat, olon)
    return dict(time=iso_ms(t), lat=olat, lon=olon, distanceKm=dist / 1000, azimuth=az, apparentAltitude=app, angularRadius=rad,
                heightEllipsoid=hE, heightMsl=hE - N, geoidUndulation=N)

def alignment(q):
    body = q.get("body")
    if body not in ("sun", "moon"): raise BadInput("body must be sun or moon")
    B = SUN if body == "sun" else MOON
    tlat, tlon, th = fnum(q, "targetLat", lo=-90, hi=90), fnum(q, "targetLon", lo=-180, hi=180), fnum(q, "targetHeight")
    tref, oref = q.get("targetHeightRef", "ellipsoid"), q.get("heightRef", "ellipsoid")
    if tref not in ("ellipsoid", "msl") or oref not in ("ellipsoid", "msl"): raise BadInput("heightRef / targetHeightRef must be ellipsoid or msl")
    tN = geoid_n(tlat, tlon)
    if tref == "msl": th = th + tN
    step, maxd = fnum(q, "stepSeconds", 60.0, 1, 3600), fnum(q, "maxDistanceKm", 20.0, 0.01, 200)
    if "height" not in q: oh, msl = 0.0, True          # no height: the eye on the geoid, as every endpoint
    else: oh, msl = fnum(q, "height", lo=-500, hi=100000), oref == "msl"
    eye = (lambda la, lo: oh + geoid_n(la, lo)) if msl else (lambda la, lo: oh)
    T, P, dut1 = fnum(q, "temperature", 10.0), fnum(q, "pressure", 1010.0), fnum(q, "dut1", 0.0, -0.9, 0.9)
    s, e = parse_utc(q.get("start")), parse_utc(q.get("end"))
    if e <= s or (e - s).total_seconds() / step > 2000: raise BadInput("end must follow start, at most 2000 steps")
    if ("lat" in q) != ("lon" in q): raise BadInput("lat and lon go together")
    ts = timescale_with_dut1(dut1); track = []
    n = int((e - s).total_seconds() // step) + 1
    for i in range(n):
        p = standing_point(B, ts.from_datetime(s + dt.timedelta(seconds=i * step)), T, P, tlat, tlon, th, eye, maxd * 1000)
        if p: track.append(p)
    out = dict(body=body, target=dict(lat=tlat, lon=tlon, height=th, heightEllipsoid=th, heightMsl=th - tN, geoidUndulation=tN, heightRef=tref),
               track=track, provenance=PROV)
    if "lat" in q:
        olat, olon = fnum(q, "lat", lo=-90, hi=90), fnum(q, "lon", lo=-180, hi=180)
        el, dist = target_elevation(olat, olon, eye(olat, olon), tlat, tlon, th)
        az_t, _, _ = GEOD.inv(olon, olat, tlon, tlat); az_t %= 360
        o = EARTH + wgs84.latlon(olat, olon, elevation_m=eye(olat, olon))
        def look(tt):
            return body_position(o, B, ts.tt_jd(tt), T, P)
        def d_az(tt): return ((look(tt)["azimuth"] - az_t + 540) % 360) - 180
        t0, t1 = ts.from_datetime(s).tt, ts.from_datetime(e).tt
        passes = []
        for x, up in _crossings(d_az, t0, t1, 2.0):
            if abs(d_az(x)) < 1:
                p = look(x); passes.append(dict(time=iso_ms(ts.tt_jd(x)), altitudeOffset=p["apparentAltitude"] - el, angularRadius=p["angularRadius"], apparentAltitude=p["apparentAltitude"]))
        out["fromObserver"] = dict(azimuthToTarget=az_t, distanceKm=dist / 1000, targetElevation=el, passes=passes)
    return out

ROUTES = {"/v1/position": position, "/v1/day": day, "/v1/crossing": crossing, "/v1/alignment": alignment}
ALLOWED = {
    "/v1/position": {"lat", "lon", "height", "heightRef", "time", "temperature", "pressure", "horizon", "dut1"},
    "/v1/day": {"lat", "lon", "height", "heightRef", "date", "tz", "temperature", "pressure", "horizon", "horizonProfile", "aim", "dut1"},
    "/v1/crossing": {"lat", "lon", "height", "heightRef", "body", "altitude", "altitudeType", "horizonProfile", "aim", "direction",
                     "start", "end", "date", "tz", "temperature", "pressure", "dut1"},
    "/v1/alignment": {"body", "targetLat", "targetLon", "targetHeight", "targetHeightRef", "height", "heightRef", "start", "end", "stepSeconds", "maxDistanceKm",
                      "temperature", "pressure", "dut1", "lat", "lon"},
}
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, obj):
        b = json.dumps(obj).encode(); self.send_response(code); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        u = urlparse(self.path); q = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path == "/healthz": return self._send(200, dict(ok=True, implementation=PROV["implementation"], version=PROV["version"]))
        f = ROUTES.get(u.path)
        if not f: return self._send(404, dict(_tag="NotFound"))
        extra = sorted(set(q) - ALLOWED[u.path])
        if extra: return self._send(400, dict(_tag="InvalidRequest", kind="UnknownParameter", unknown=extra, allowed=sorted(ALLOWED[u.path])))
        try: self._send(200, f(q))
        except BadInput as e: self._send(400, dict(_tag="InvalidRequest", message=str(e)))
        except OutOfRangeErr as e: self._send(400, dict(_tag="InvalidRequest", message=str(e)))

if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--port", type=int, default=8440); a = ap.parse_args()
    ThreadingHTTPServer(("127.0.0.1", a.port), H).serve_forever()
