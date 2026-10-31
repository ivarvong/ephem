# ephem API

Sun and Moon from JPL DE440, as JSON over HTTPS. CORS is open and there's no key. Every answer is checked against an
independent implementation: Skyfield for the sky, PROJ and GeographicLib for geometry, and NOAA's test values and pygeomag
for the magnetic field (see [How we know it's right](#how-we-know-its-right)). Every response states the conventions it
used.

```sh
# Where are the Sun and Moon right now?
curl 'https://ephem.ivar.workers.dev/position?lat=40.7&lon=-74'

# When do they rise and set, and when is twilight, on a local day?
curl 'https://ephem.ivar.workers.dev/day?lat=40.7&lon=-74&date=2026-11-16&tz=America/New_York'

# Where do I stand so the Moon sits on the Statue of Liberty?
curl 'https://ephem.ivar.workers.dev/alignment?body=moon&targetLat=40.68925&targetLon=-74.0445&targetHeight=70&targetHeightRef=msl&height=5&heightRef=msl&start=2026-11-17T03:44:30Z&end=2026-11-17T03:46:00Z&stepSeconds=5&maxDistanceKm=8'
```

## The questions ephem answers, one endpoint each

| Question | Endpoint |
| --- | --- |
| Where are the Sun and Moon at an instant (default now)? | `GET /position` |
| What paths do they trace across the sky over hours or days? | `GET /track` |
| What happens on a local day: rise, set, transit, twilight, golden and blue hour? | `GET /day` |
| When does a body (or a limb, or the Moon's lit-area centroid) reach a given altitude or skyline? | `GET /crossing` |
| Where do I stand so the body sits on a landmark, at each instant? Or, from a fixed spot, when does it pass? | `GET /alignment` |
| Every pass over a date range during which that standing point lies inside an area I can stand in | `POST /alignment/search` |
| Does the sight line from my eye to the landmark clear the terrain or obstacles between us? | `GET /sightline` |
| What's the magnetic declination here (to turn true azimuths into compass bearings)? | `GET /magnetic` |
| What's the weather at the nearest stations (temperature and pressure feed refraction)? | `GET /weather` |

Each endpoint answers one question. Two questions stay as separate endpoints even when they look alike (position and
track, day and crossing, alignment and search) wherever merging them would mean mode flags. For example, position takes
`time` and track takes `start`, `end` and `stepSeconds`, and they return different shapes. Merging them would add
"exactly one of" parameters and a response that changes shape. Two simple endpoints are easier to learn than one
conditional endpoint.

`/healthz`, `/openapi.json`, `/docs`, `/llms.txt` and `/mcp` are the service's own routes. None of them collides with
an API name. `/mcp` offers one tool per endpoint under the endpoint's own name (`position`, `track`, `day`, `crossing`,
`alignment`, `alignment_search`, `sightline`, `magnetic`, `weather`), and each tool takes the same arguments and
returns the same JSON as its endpoint. Parameter docs come from one table (`packages/api/src/params.ts`), which the
MCP schemas, `/docs`, `/llms.txt` and the 400 messages all read.

**No version prefix.** We have zero users and promise no compatibility, so `/v1` would be a promise we don't keep. If we
ever need to break real users, we can add a new prefix then.

## One vocabulary

| Concept | Parameters | Notes |
| --- | --- | --- |
| Observer (you) | `lat`, `lon`, `height`, `heightRef` | `height` is in metres above the WGS-84 ellipsoid, or above mean sea level (EGM96) with `heightRef=msl`. With no `height`, you stand at sea level. On `/alignment` and `/alignment/search` there is no `lat`/`lon` for the standing point, because ephem solves for it. `height` is your eye's height wherever you stand. On `/alignment`, `lat`/`lon` names an optional fixed spot. |
| Target (landmark) | `targetLat`, `targetLon`, `targetHeight`, `targetHeightRef` | Same rules as the observer. |
| Body | `body` = `sun` or `moon` | |
| Time | `time` (an instant), `start` + `end` (a window), `date` + `tz` (a local day), `stepSeconds` | UTC ISO-8601 with a trailing `Z`. The supported range is 1972 to 2149. |
| Refraction | `temperature` (°C), `pressure` (hPa), `horizon` (`sea`, `geometric` or degrees), `horizonProfile` (`az:el,…`), `dut1` | Every sky endpoint uses one refraction model. |
| Which point of the disc | `aim` = `center`, `upper`, `lower` or `litCentroid` | Replaces `limb`. `upper`, `center` and `lower` are the limbs. `litCentroid` is the Moon only. |
| Context | `include` = `sun`, `phase` or `sun,phase` | Adds the Sun's position or the Moon's phase to each event or pass. |

The POST body of `/alignment/search` uses the same names and value formats as the query parameters. The only difference
is `region`, which is GeoJSON or a bbox.

**Errors.** Every error has the same shape: `{"_tag", "message", "parameter"?, "allowed"?}`.
- `400 InvalidRequest` covers every problem with the request: an unknown parameter, a missing one, a malformed one, an
  out-of-range one, or an impossible combination. The message names the parameter, says what was wrong and says what is
  allowed. For example: `lat=100 is not valid: Observer latitude, degrees north, −90 to 90 (WGS-84).` An unknown
  parameter gets a "did you mean" for both renamed parameters (`observerHeight` → `height`) and misspelled ones
  (`temprature` → `temperature`).
- `503 Unavailable` means a data source (the geoid or the METAR feed) failed. ephem fails closed and doesn't guess.
- `404 NotFound` lists the endpoints.

**Every response** carries `provenance` (the implementation, version and data sources, plus blocks read, compute time
and cache tiers) and `conventions` (every threshold, model, height reference and input default it used).

## What changes from today

| Before | After | Why |
| --- | --- | --- |
| `/v1/*` | `/*` | No version prefix (see above). |
| `/v1/alignment/search/window` (public GET) | internal only | It's a cache unit of the search, not a question anyone asks. The front door no longer routes it, and OpenAPI, the docs and MCP don't list it. |
| `limb` on `/day` and `/crossing`, plus `aim` on `/crossing` | `aim` everywhere | One name for "which point of the disc". `/crossing` used to accept both, with a "not both" rule. |
| `/alignment` `observerHeight`, `observerLat`, `observerLon` | `height`, `lat`, `lon` | The same names as every other endpoint. |
| `/sightline` `observerLat`, `observerLon`, `observerHeight` | `lat`, `lon`, `height` | Same reason. |
| search body `target:{lat,lon,height,heightRef}`, `observerHeight`, `include:[…]` | `targetLat`, `targetLon`, `targetHeight`, `targetHeightRef`, `height`, `include:"sun,phase"` | The body uses the same names as `/alignment`'s query. |
| search pass `moon:{az,alt,illuminated}`, `sunAlt` | `azimuth`, `apparentAltitude`, `angularRadius`, `illuminatedFraction`, `sun:{azimuth,altitude,apparentAltitude}` | The same field names as every other response. The old block was called `moon` even when `body=sun`. |
| `/weather` `n` | `count` | Guessable. |
| `/magnetic` `height` (ellipsoid only) | `height`, `heightRef` | The same observer vocabulary as everywhere else. |
| 400 for some errors, 422 `InvalidInput`/`OutOfRange` for others, `GeoidUnavailable`/`WeatherUnavailable` | 400 `InvalidRequest`, 503 `Unavailable` | One error shape. Every 400 names the parameter and what's allowed. |
| `conventions` and `provenance` on some endpoints | on every endpoint (magnetic and weather gain them) | Every answer explains itself. |

**Nothing is removed.** Every capability stays: aim, include, horizon profiles, refraction inputs, alignment search,
sightline, magnetic and weather. The only route that leaves the public surface is the internal search window.

## How we know it's right

Every cell below names the independent check that covers that endpoint and input, and every one runs in the gate
(`npm test`), offline, on every commit. **Skyfield** is `reference/oracle/server.py` (Skyfield 1.55 + JPL DE440s, pyproj
for heights), whose answers are frozen in `packages/core/test/fixtures/oracle.json` and compared at the bars in
`reference/oracle/crosscheck.py`: 0.36″ on angles, 0.5 s on events, 1 m on standing points. **PROJ/GeographicLib** is
pyproj called from the test. **NOAA** is the WMM2025 official test values, and **pygeomag** is independent WMM code on
NOAA's coefficients (`reference/oracle/wmm_poles.py`). A **property** is an invariant or a brute-force recomputation that
shares no code with the path under test. The sweep of 2026-10-31 went from **49 of 75 applicable cells to 75 of 75** (26 new, 5 extended); new checks are
marked ★.

| Input or case | /position | /track | /day | /crossing | /alignment | /alignment/search |
| --- | --- | --- | --- | --- | --- | --- |
| The answer itself | Skyfield (129 instants, 1972–2149) | property: each sample = /position | Skyfield (118 days) | Skyfield (19 windows) | Skyfield (4 tracks) + property (the body sits on the target) | brute-force 1 s scans (3 geometries, 30–60 days) |
| `height`, `heightRef` (ellipsoid, msl, default) | Skyfield | ★ property (= /position, msl) | Skyfield | Skyfield | property; ★ Skyfield (msl eye and target) | brute force (msl) |
| `temperature`, `pressure` | Skyfield | ★ property | Skyfield | Skyfield | ★ Skyfield | ★ /alignment's solver (Skyfield with T/P) |
| `horizon` (sea, geometric, degrees) | Skyfield | ★ property | Skyfield | n/a | n/a | n/a |
| `horizonProfile` | n/a | n/a | Skyfield | Skyfield | n/a | n/a |
| `horizonProfile` wrapping through north | n/a | n/a | ★ Skyfield (NYC, Tromsø midnight Sun) + property | ★ Skyfield + property (= /day) | n/a | n/a |
| `aim` upper, lower | n/a | n/a | Skyfield | Skyfield; ★ property past the zenith (bug 2) | property (offset = radius along the vertical) | n/a |
| `aim` litCentroid | n/a | n/a | n/a | property (moves moonset by offset·cos/rate) + Skyfield sphere integration of the centroid | property (geometry re-check) | property (entry 30–50 s earlier, as measured) |
| `include` sun, phase | n/a | n/a | n/a | property (= /position) | property (= /position) | ★ property (= /position) |
| `body` sun, moon | Skyfield (both always) | property | Skyfield | Skyfield | Skyfield | brute force (both) |
| `dut1` | Skyfield | ★ property | ★ Skyfield | ★ Skyfield | ★ Skyfield | n/a |
| DST days, non-hour offsets (Kathmandu +5:45, Chatham +12:45, Lord Howe ½ h DST) | n/a | n/a | ★ Skyfield; local midnight vs Python zoneinfo (3 718 cases) | ★ Skyfield (Kathmandu) | n/a | n/a |
| Dates not on the calendar, days a zone skipped | n/a | n/a | ★ property (bug 1) | ★ property (bug 1) | n/a | n/a |
| Polar day and night | ★ Skyfield (±89.9°, ±90°) | n/a | Skyfield (Tromsø); ★ Longyearbyen, McMurdo, 89.9°N equinoxes | Skyfield (Tromsø); ★ Longyearbyen | n/a | n/a |
| The date line (lon ±180, UTC+14, UTC−11) | ★ Skyfield + property (180 = −180) | n/a | ★ Skyfield (Kiritimati, Pago Pago, Fiji) + property | n/a | n/a | n/a |
| Near the zenith | ★ Skyfield (88.4°–89.5°) | n/a | Skyfield (Quito equinoxes) | ★ Skyfield (centre at 85°–89°) + property (limbs) | n/a | n/a |
| Region: bbox, Polygon, holes, MultiPolygon | n/a | n/a | n/a | n/a | n/a | brute force (holed MultiPolygon, 424-node park) + round-trip encoding |

| Input or case | /sightline | /magnetic | /weather |
| --- | --- | --- | --- |
| The answer itself | property (curvature s₁s₂/2R, refraction k·s₁s₂/2R); ★ PROJ + GeographicLib in the gate (was an offline script) | NOAA (100 values) | real METAR file: parser = Python csv (5 254 rows); nearest = brute-force haversine |
| `height`, `heightRef` | property (heightEllipsoid = heightMsl + N) | ★ property (msl = height + N) + pygeomag at 5 km | n/a |
| Long lines (to the 200 km limit) and the antimeridian | ★ PROJ + GeographicLib (6 lines, 201 samples) | n/a | property (antimeridian, poles) |
| Near the poles | ★ PROJ (over the North Pole: bug 3) | ★ pygeomag (1 128 points at |lat| 80°–90°, dip poles) | property |
| `obstacles`, `samples` | property (clearance = line − obstacle; = interpolated profile) | n/a | n/a |
| Compass zones (blackout, caution; new output) | n/a | ★ pygeomag zones (bug 4) | n/a |
| Declination for bearings | n/a | NOAA; FAA NASR airport variation (offline, `scripts/check-magvar.py`) | property (magnetic = true − declination) |
| `count` | n/a | n/a | property |

**Bugs the sweep found** (each has a regression test that fails on the old code):
1. `date=2026-02-30` answered for 2026-03-02 under the label 2026-02-30, and Pacific/Apia's skipped 2011-12-30 was a 200
   with an empty day. Both are now a 400 naming `date`.
2. An upper limb within its radius of the zenith was put at alt + r > 90°, so `/crossing` missed half the crossings
   (2 instead of 4). The limb now comes down the other side, as `aim`'s definition and `/alignment` already had it.
3. A sight line over the North Pole put its middle sample 6 355 km below the ellipsoid (h = p/cos φ − N is 0/0 there).
4. `/magnetic` gave a declination inside WMM2025's blackout zone with no warning. It now says `compass: blackout | caution | ok`.

Every example in `/docs`, `/llms.txt` and this file runs in the gate and has its claim checked
(`packages/worker/test/docs-examples.test.ts`).

**Not covered, and why.** We don't compare azimuth with Skyfield within about 0.3° of the zenith. There it is
ill-conditioned: 8′ from the zenith, a 2.4e-4° azimuth difference is 6e-7° on the sky. The limb geometry there is covered by
a property instead. Skyfield has no lit-area centroid and no `/alignment` aim, so those cells rest on properties and on the
centroid's sphere integration. /weather's values are the station's own report, not computed by ephem, so there is no oracle
beyond the parser and the distance math.
