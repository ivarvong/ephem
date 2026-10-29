#!/usr/bin/env python3
"""Deterministic reference: when does the Sun's lower limb appear to touch the terrain horizon?

This file is the executable form of the spec "Terrain Sunset Contact — Math Spec". Every constant,
step size and tolerance is named here and in the spec; changing one changes the golden vectors.

Pipeline
  1. Sun: topocentric vacuum (unrefracted) altitude/azimuth from JPL DE440s via Skyfield.
  2. Semidiameter: SD = 959.63″ / r_au.
  3. Atmosphere: US Standard Atmosphere 1976 layers, surface T0/P0 overridden; Edlén (1966) refractivity at 550 nm.
  4. Ray trace: 2-D, spherically symmetric, Euler radius in the azimuth; RK4 in arc length.
  5. Horizon: the lowest launch angle whose ray clears the Copernicus GLO-30 surface for 300 m ≤ d ≤ 180 km.
  6. Contact: true altitude of the Sun's centre = (horizon apparent altitude − refraction of that ray) + SD.
"""
from __future__ import annotations
import glob, hashlib, json, math, os, sys
from dataclasses import dataclass, asdict
import numpy as np
import rasterio
from pyproj import Geod
from skyfield.api import load, wgs84

HERE = os.path.dirname(os.path.abspath(__file__))
INPUTS = os.path.join(HERE, "inputs")

# ─────────────────────────────── constants (spec §2) ───────────────────────────────
WGS84_A = 6378137.0
WGS84_F = 1 / 298.257223563
WGS84_E2 = WGS84_F * (2 - WGS84_F)
G0 = 9.80665                 # m s⁻²
M_AIR = 0.0289644            # kg mol⁻¹
R_GAS = 8.3144598            # J mol⁻¹ K⁻¹
LAMBDA_UM = 0.550            # effective wavelength, µm
SUN_SD_1AU_ARCSEC = 959.63   # solar semidiameter at 1 au (Astronomical Almanac / Meeus)
H_TOP = 85_000.0             # ray-trace exit height, m
DS_LOW, DS_HIGH, H_SWITCH = 10.0, 100.0, 5_000.0   # RK4 step (m) below / above H_SWITCH
D_MIN, D_MAX, D_STEP = 300.0, 180_000.0, 10.0       # terrain profile window and spacing, m
ANGLE_TOL_DEG = 1e-7         # bisection tolerance for the horizon launch angle
TIME_TOL_S = 1e-3            # bisection tolerance for the contact time
US76_LAYERS = [(0, -6.5e-3), (11_000, 0.0), (20_000, 1.0e-3), (32_000, 2.8e-3), (47_000, 0.0), (51_000, -2.8e-3), (71_000, -2.0e-3)]

# ─────────────────────────────── step 3: atmosphere + refractivity ───────────────────────────────
def edlen_ns_minus_1(lam_um: float) -> float:
    """Edlén (1966) dispersion of standard dry air (15 °C, 101325 Pa)."""
    s2 = (1 / lam_um) ** 2
    return (8342.54 + 2406147 / (130 - s2) + 15998 / (38.9 - s2)) * 1e-8

NS1 = edlen_ns_minus_1(LAMBDA_UM)
C_REFR = NS1 * 288.15 / 1013.25          # (n−1) = C_REFR · P[hPa] / T[K]

@dataclass(frozen=True)
class Atmosphere:
    T0: float   # K at h = 0 (mean sea level)
    P0: float   # hPa at h = 0

    def layers(self):
        """Base (h, T, P, lapse) per layer, built from the surface values."""
        out, T, P = [], self.T0, self.P0
        for i, (hb, L) in enumerate(US76_LAYERS):
            out.append((hb, T, P, L))
            if i + 1 < len(US76_LAYERS):
                ht = US76_LAYERS[i + 1][0]; dh = ht - hb
                if L == 0: P = P * math.exp(-G0 * M_AIR * dh / (R_GAS * T))
                else:      P = P * ((T + L * dh) / T) ** (-G0 * M_AIR / (R_GAS * L)); T = T + L * dh
        return out

    def TP(self, h: float) -> tuple[float, float]:
        lay = self._lay
        i = 0
        while i + 1 < len(lay) and h >= lay[i + 1][0]: i += 1
        hb, Tb, Pb, L = lay[i]; dh = h - hb
        if L == 0: return Tb, Pb * math.exp(-G0 * M_AIR * dh / (R_GAS * Tb))
        T = Tb + L * dh; return T, Pb * (T / Tb) ** (-G0 * M_AIR / (R_GAS * L))

    def n_and_dlnn(self, h: float) -> tuple[float, float]:
        """n(h) and d(ln n)/dh, analytic: d(n−1)/dh = (n−1)(dP/P − dT/T)/dh with dP/P = −g M /(R T) dh."""
        T, P = self.TP(h)
        i = 0
        while i + 1 < len(self._lay) and h >= self._lay[i + 1][0]: i += 1
        L = self._lay[i][3]
        nm1 = C_REFR * P / T
        dnm1 = nm1 * (-G0 * M_AIR / (R_GAS * T) - L / T)
        n = 1 + nm1
        return n, dnm1 / n

    def __post_init__(self):
        object.__setattr__(self, "_lay", self.layers())

# ─────────────────────────────── geometry ───────────────────────────────
def euler_radius(lat_deg: float, az_deg: float) -> float:
    """Radius of curvature of the WGS-84 normal section at latitude φ in azimuth α."""
    s = math.sin(math.radians(lat_deg)); w = 1 - WGS84_E2 * s * s
    M = WGS84_A * (1 - WGS84_E2) / w ** 1.5; N = WGS84_A / math.sqrt(w)
    a = math.radians(az_deg)
    return 1 / (math.cos(a) ** 2 / M + math.sin(a) ** 2 / N)

# ─────────────────────────────── step 4: ray trace ───────────────────────────────
def trace(atm: Atmosphere, Re: float, h0: float, e0_deg: float, terrain=None):
    """RK4 in arc length s of the state (r, θ, e):
         dr/ds = sin e,  dθ/ds = cos e / r,  de/ds = cos e · (1/r + d(ln n)/dr).
       Returns ('ground', d) if the ray meets terrain, else ('space', refraction_deg, true_alt_deg)."""
    def f(r, e):
        _, g = atm.n_and_dlnn(r - Re)
        c = math.cos(e)
        return math.sin(e), c / r, c * (1 / r + g)
    r, th, e = Re + h0, 0.0, math.radians(e0_deg)
    while True:
        h = r - Re
        if h >= H_TOP:
            true_alt = math.degrees(e - th)
            return ("space", e0_deg - true_alt, true_alt)
        ds = DS_LOW if h < H_SWITCH else DS_HIGH
        k1 = f(r, e)
        k2 = f(r + ds/2*k1[0], e + ds/2*k1[2])
        k3 = f(r + ds/2*k2[0], e + ds/2*k2[2])
        k4 = f(r + ds*k3[0], e + ds*k3[2])
        r  += ds/6*(k1[0] + 2*k2[0] + 2*k3[0] + k4[0])
        th += ds/6*(k1[1] + 2*k2[1] + 2*k3[1] + k4[1])
        e  += ds/6*(k1[2] + 2*k2[2] + 2*k3[2] + k4[2])
        if terrain is not None:
            d = Re * th                                   # ground distance along the sphere of radius Re
            if D_MIN <= d <= D_MAX:
                ht = float(np.interp(d, terrain[0], terrain[1]))
                if r - Re <= ht: return ("ground", d)
            if d > D_MAX and terrain is not None: terrain = None    # past the profile: free flight
        if r - Re < -100: return ("ground", Re * th)

# ─────────────────────────────── step 5: terrain profile + horizon ───────────────────────────────
GEOD = Geod(ellps="WGS84")
_TILES = None
def _tiles():
    global _TILES
    if _TILES is None:
        _TILES = [(t, t.read(1).astype(np.float64)) for t in (rasterio.open(p) for p in sorted(glob.glob(os.path.join(INPUTS, "Copernicus_*.tif"))))]
    return _TILES

def dem_bilinear(lon: np.ndarray, lat: np.ndarray) -> np.ndarray:
    """Bilinear interpolation between cell centres; heights are EGM2008 orthometric (m above MSL)."""
    out = np.full(lon.shape, np.nan)
    for t, a in _tiles():
        b = t.bounds
        m = (lon >= b.left) & (lon < b.right) & (lat > b.bottom) & (lat <= b.top)
        if not m.any(): continue
        inv = ~t.transform
        c, r = inv * (lon[m], lat[m])                   # fractional col/row of the corner grid
        c = np.asarray(c) - 0.5; r = np.asarray(r) - 0.5  # → relative to cell centres
        c0 = np.clip(np.floor(c).astype(int), 0, a.shape[1] - 2); r0 = np.clip(np.floor(r).astype(int), 0, a.shape[0] - 2)
        fc = np.clip(c - c0, 0, 1); fr = np.clip(r - r0, 0, 1)
        out[m] = (a[r0, c0]*(1-fc)*(1-fr) + a[r0, c0+1]*fc*(1-fr) + a[r0+1, c0]*(1-fc)*fr + a[r0+1, c0+1]*fc*fr)
    return out

def terrain_profile(lat0, lon0, az_deg):
    d = np.arange(D_MIN, D_MAX + D_STEP, D_STEP)
    lon, lat, _ = GEOD.fwd(np.full_like(d, lon0), np.full_like(d, lat0), np.full_like(d, az_deg), d)
    h = dem_bilinear(np.asarray(lon), np.asarray(lat))
    return d, np.nan_to_num(h, nan=-1e6), np.asarray(lat), np.asarray(lon)

def horizon(atm, lat0, lon0, h0, az_deg):
    """Lowest apparent launch angle (deg) whose ray clears the terrain; bisection on a monotone predicate."""
    Re = euler_radius(lat0, az_deg)
    d, h, la, lo = terrain_profile(lat0, lon0, az_deg)
    lo_a, hi_a = -1.0, 1.0
    assert trace(atm, Re, h0, hi_a, (d, h))[0] == "space" and trace(atm, Re, h0, lo_a, (d, h))[0] == "ground"
    hit = None
    while hi_a - lo_a > ANGLE_TOL_DEG:
        mid = (lo_a + hi_a) / 2
        res = trace(atm, Re, h0, mid, (d, h))
        if res[0] == "ground": lo_a, hit = mid, res[1]
        else: hi_a = mid
    i = int(np.clip(round((hit - D_MIN) / D_STEP), 0, len(d) - 1))
    _, refr, true_alt = trace(atm, Re, h0, hi_a)       # same ray, no terrain, out to space
    return dict(apparent_deg=hi_a, refraction_deg=refr, true_alt_deg=true_alt, Re_m=Re,
                limit_d_m=float(d[i]), limit_ground_m=float(h[i]), limit_lat=float(la[i]), limit_lon=float(lo[i]))

# ─────────────────────────────── steps 1, 2, 6: Sun + contact ───────────────────────────────
TS = load.timescale(builtin=True)
EPH = load(os.path.join(INPUTS, "de440s.bsp"))
SUN, EARTH = EPH["sun"], EPH["earth"]

def sun_true(obs, t):
    app = obs.at(t).observe(SUN).apparent()
    alt, az, dist = app.altaz()                         # no temperature/pressure → no refraction
    return alt.degrees, az.degrees, dist.au

@dataclass
class Case:
    name: str
    lat: float; lon: float
    H_msl: float            # observer eye height above MSL (EGM2008), m
    N_geoid: float          # EGM2008 geoid undulation at the observer, m (ellipsoidal h = H + N)
    T0: float; P0: float    # surface atmosphere at MSL
    t_lo_utc: tuple; t_hi_utc: tuple   # bracket for the contact time

def solve(c: Case):
    atm = Atmosphere(c.T0, c.P0)
    obs = EARTH + wgs84.latlon(c.lat, c.lon, elevation_m=c.H_msl + c.N_geoid)
    t_lo, t_hi = TS.utc(*c.t_lo_utc), TS.utc(*c.t_hi_utc)
    # Fixed point on azimuth: horizon depends on az(t); the Sun's az moves ~0.15°/min, so 2–3 passes converge.
    t_est = TS.tt_jd((t_lo.tt + t_hi.tt) / 2); prev = None
    for it in range(8):
        _, az, _ = sun_true(obs, t_est)
        hz = horizon(atm, c.lat, c.lon, c.H_msl, az)
        def g(t):                                         # true centre altitude minus the contact altitude
            alt, _, r = sun_true(obs, t); sd = SUN_SD_1AU_ARCSEC / r / 3600
            return alt - (hz["true_alt_deg"] + sd)
        a, b = t_lo.tt, t_hi.tt
        assert g(TS.tt_jd(a)) > 0 > g(TS.tt_jd(b))
        while (b - a) * 86400 > TIME_TOL_S:
            m = (a + b) / 2
            if g(TS.tt_jd(m)) > 0: a = m
            else: b = m
        t_est = TS.tt_jd((a + b) / 2)
        if prev is not None and abs(t_est.tt - prev) * 86400 < TIME_TOL_S: break
        prev = t_est.tt
    alt, az, r = sun_true(obs, t_est); sd = SUN_SD_1AU_ARCSEC / r / 3600
    return dict(case=c.name, contact_utc=t_est.utc_strftime("%Y-%m-%dT%H:%M:%S.") + f"{int(round((t_est.utc.second % 1)*1000)):03d}Z",
                iterations=it + 1, sun_az_deg=az, sun_true_alt_centre_deg=alt, semidiameter_deg=sd, sun_dist_au=r, **hz)

# ─────────────────────────────── validation (spec §10) ───────────────────────────────
def validation():
    atm = Atmosphere(283.15, 1010.0)                    # the conditions Bennett/Saemundsson are quoted for
    Re = 6371000.0
    rows = []
    for a in (0.0, 1.0, 2.0, 5.0, 10.0, 20.0, 45.0):
        _, refr, _ = trace(atm, Re, 0.0, a)
        bennett = 1 / math.tan(math.radians(a + 7.31 / (a + 4.4))) / 60   # Bennett (1982), apparent altitude in, degrees out
        rows.append(dict(apparent_deg=a, trace_arcmin=refr * 60, bennett_arcmin=bennett * 60, diff_arcsec=(refr - bennett) * 3600))
    return rows

def sha256(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""): h.update(b)
    return h.hexdigest()

CASES = [
    Case("central_park", 40.7829, -73.9654, 321.6, -32.6, 290.35, 1024.0, (2026,10,20,21,55), (2026,10,20,22,20)),
    Case("midtown",      40.7540, -73.9840, 321.6, -32.6, 290.35, 1024.0, (2026,10,20,21,55), (2026,10,20,22,20)),
    Case("lower_manhattan", 40.7127, -74.0134, 321.6, -32.6, 290.35, 1024.0, (2026,10,20,21,55), (2026,10,20,22,20)),
]

if __name__ == "__main__":
    lock = {os.path.basename(p): sha256(os.path.realpath(p)) for p in sorted(glob.glob(os.path.join(INPUTS, "*"))) if not p.endswith(".json")}
    atm = Atmosphere(290.35, 1024.0)
    k300 = -euler_radius(40.7829, 256.5) * atm.n_and_dlnn(300.0)[1]
    out = dict(
        spec="terrain-sunset/1",
        inputs_sha256=lock,
        constants=dict(lambda_um=LAMBDA_UM, edlen_ns_minus_1=NS1, C_refr=C_REFR, sun_sd_1au_arcsec=SUN_SD_1AU_ARCSEC,
                       ds_low_m=DS_LOW, ds_high_m=DS_HIGH, h_switch_m=H_SWITCH, h_top_m=H_TOP,
                       d_min_m=D_MIN, d_max_m=D_MAX, d_step_m=D_STEP, angle_tol_deg=ANGLE_TOL_DEG, time_tol_s=TIME_TOL_S),
        checks=dict(n_minus_1_sea_level=C_REFR * 1024.0 / 290.35, k_at_300m=k300),
        validation=validation(),
        cases=[solve(c) for c in CASES],
    )
    json.dump(out, sys.stdout, indent=1, default=float); print()
