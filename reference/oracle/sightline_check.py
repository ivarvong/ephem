# Independent check of /sightline geometry: PROJ (ECEF <-> geodetic, EPSG 4978/4979) and GeographicLib (pyproj.Geod).
import json, sys, numpy as np
from pyproj import Transformer, Geod
G = Geod(ellps="WGS84"); to = Transformer.from_crs(4979, 4978, always_xy=True); back = Transformer.from_crs(4978, 4979, always_xy=True)
for f in sys.argv[1:]:
    j = json.load(open(f)); o, t = j["observer"], j["target"]
    O = np.array(to.transform(o["lon"], o["lat"], o["heightEllipsoid"])); T = np.array(to.transform(t["lon"], t["lat"], t["heightEllipsoid"]))
    n = len(j["profile"]); w = dict(h=0, d=0, foot=0, msl=0)
    for i, p in enumerate(j["profile"]):
        lon, lat, h = back.transform(*(O + (T - O) * i / (n - 1)))
        _, _, d = G.inv(o["lon"], o["lat"], lon, lat)
        w["h"] = max(w["h"], abs(h - p["heightEllipsoid"])); w["d"] = max(w["d"], abs(d - p["distanceKm"] * 1000))
        w["foot"] = max(w["foot"], abs(lat - p["lat"]) * 111132, abs(lon - p["lon"]) * 111320 * np.cos(np.radians(lat)))
        w["msl"] = max(w["msl"], abs(p["heightEllipsoid"] - p["geoidUndulation"] - p["heightMsl"]))
    print(f, j["distanceKm"], {k: f"{v:.2e} m" for k, v in w.items()})
