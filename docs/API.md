# ephem API

Sun and Moon from JPL DE440, as JSON over HTTPS. CORS is open and there's no key. Every answer is checked against
Skyfield, and every response states the conventions it used.

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
