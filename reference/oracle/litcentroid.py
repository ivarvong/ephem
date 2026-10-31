# Independent check of the lit-area centroid: Skyfield (DE440s) topocentric Moon and Sun, then a brute-force integration
# over the lunar sphere (Fibonacci points; visible from the eye AND sunlit; weighted by the solid angle each surface
# element subtends at the eye), projected on the observer's sky tangent plane at the Moon's centre. No closed form used.
import json
import math
import sys

import numpy as np
from skyfield.api import load, wgs84

eph = load(sys.argv[1])
ts = load.timescale()
cases = json.loads(sys.argv[2])
R_MOON = 1737.4
N = 2_000_000
k = np.arange(N) + 0.5
z = 1 - 2 * k / N
ph = np.pi * (1 + 5**0.5) * k
rr = np.sqrt(1 - z * z)
nrm = np.stack([rr * np.cos(ph), rr * np.sin(ph), z], 1)  # unit normals, equal-area
out = []
for c in cases:
    t = ts.utc(*c["t"])
    obs = eph["earth"] + wgs84.latlon(c["lat"], c["lon"], elevation_m=c["h"])

    def enu(body):
        alt, az, d = obs.at(t).observe(eph[body]).apparent().altaz()  # no refraction
        a, zz, dk = alt.radians, az.radians, d.km
        return np.array([dk * math.cos(a) * math.sin(zz), dk * math.cos(a) * math.cos(zz), dk * math.sin(a)])

    M, S = enu("moon"), enu("sun")
    P = M + R_MOON * nrm  # surface points, eye at origin (ENU)
    vis = np.einsum("ij,ij->i", nrm, -P) > 0  # facing the eye
    lit = np.einsum("ij,ij->i", nrm, S - P) > 0  # facing the Sun
    to = P / np.linalg.norm(P, axis=1)[:, None]
    w = np.einsum("ij,ij->i", nrm, -to) / np.einsum("ij,ij->i", P, P)  # dΩ ∝ cos θ / d²
    m = M / np.linalg.norm(M)
    up = np.array([0, 0, 1.0])
    vert = up - up.dot(m) * m
    vert /= np.linalg.norm(vert)
    right = np.cross(m, vert)
    # gnomonic coordinates on the sky plane at the Moon centre, radians
    x = to @ right / (to @ m)
    y = to @ vert / (to @ m)
    sel = vis & lit
    W = w[sel]
    cx, cy = (W * x[sel]).sum() / W.sum(), (W * y[sel]).sum() / W.sum()
    rho = math.degrees(math.hypot(cx, cy))
    psi = math.degrees(math.atan2(cx, cy)) % 360
    radius = math.degrees(math.asin(R_MOON / np.linalg.norm(M)))
    vfrac = w[sel].sum() / w[vis].sum()
    out.append(
        dict(
            case=c,
            offsetArcmin=rho * 60,
            angleFromVertical=psi,
            radiusArcmin=radius * 60,
            litFractionOfDisc=vfrac,
            moonAltTrue=math.degrees(math.asin(m[2])),
            moonAz=math.degrees(math.atan2(m[0], m[1])) % 360,
        )
    )
print(json.dumps(out, indent=1))
