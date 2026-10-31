// Every parameter's meaning and allowed values, once (docs/API.md "One vocabulary"). MCP tool arguments, /docs, /llms.txt and
// 400 messages all read this table, so a parameter means one thing everywhere and its docs cannot drift between them.
// PARAM_DOCS is the shared meaning; PATH_DOCS overrides it where an endpoint gives the name a narrower sense.

const HEIGHT_REF = "What the height is measured from: ellipsoid (default; WGS-84, as GPS reports) or msl (mean sea level, the EGM96 geoid; as maps and iOS altitude report)."
const T_PROFILE = "Skyline as azimuth:elevation pairs, comma-separated (degrees true : apparent degrees, as measured), e.g. 0:1.2,90:0.4,180:2.5,270:0.8; 1–360 points, linear in azimuth with wraparound, elevations ≥ −1.6963."

export const PARAM_DOCS: Readonly<Record<string, string>> = {
  lat: "Observer latitude, degrees north, −90 to 90 (WGS-84).",
  lon: "Observer longitude, degrees east, −180 to 180 (WGS-84).",
  height: "Observer height, metres (−500 to 100 000), measured from heightRef. Omitted: you stand at sea level (on the geoid).",
  heightRef: HEIGHT_REF,
  targetLat: "Target (landmark) latitude, degrees north, −90 to 90.",
  targetLon: "Target (landmark) longitude, degrees east, −180 to 180.",
  targetHeight: "Height of the point to frame (e.g. a torch or a tower top), metres (−500 to 100 000), measured from targetHeightRef.",
  targetHeightRef: "What targetHeight is measured from: ellipsoid (default) or msl (EGM96, mean sea level).",
  body: "sun or moon.",
  time: "UTC instant, ISO-8601 with a trailing Z (e.g. 2026-11-17T03:45:00Z), 1972-01-01 to 2149-12-31. Default: now.",
  start: "Window start, UTC ISO-8601 with a trailing Z (e.g. 2026-11-16T00:00:00Z).",
  end: "Window end, UTC ISO-8601 with a trailing Z, after start.",
  date: "Local calendar date, YYYY-MM-DD (with tz).",
  tz: "IANA time zone, e.g. America/New_York; the day runs local midnight to local midnight.",
  stepSeconds: "Sampling step, seconds.",
  temperature: "Air temperature for refraction, °C (−90 to 60). Default 10.",
  pressure: "Air pressure for refraction, hPa (0 to 1100). Default 1010.",
  horizon: "Where the horizon is: sea (default: the sea horizon, dipped by your height above sea level), geometric (0°), or an apparent altitude in degrees (−1.6963 to 89).",
  horizonProfile: T_PROFILE + " Replaces horizon.",
  dut1: "UT1 − UTC, seconds (−0.9 to 0.9). Default 0.",
  aim: "Which point of the disc: center, upper or lower (the limbs along the local vertical), or litCentroid (the centroid of the Moon's lit area; body=moon).",
  include: "Extra context per result: sun (the Sun's azimuth and true / apparent altitude there and then), phase (the Moon's phase), or sun,phase.",
  altitude: "Altitude to cross, degrees (−90 to 90); true unless altitudeType=apparent. Required unless horizonProfile.",
  altitudeType: "true (default: vacuum altitude, as twilight thresholds are defined) or apparent (refracted, as /position's apparentAltitude).",
  direction: "rise (upward crossings), set (downward) or either (default).",
  maxDistanceKm: "Farthest standing point to report, km (0.01 to 200). Default 20.",
  samples: "Points along the sight line, 2 to 1001. Default 101.",
  obstacles: "Obstacle points lat:lon:heightMsl, comma-separated (up to 100; heights in metres above sea level), e.g. 40.6894:-74.0166:25. Each gets its clearance below the line.",
  count: "How many stations, nearest first, 1 to 10. Default 1.",
  region: "Where you can stand: a GeoJSON Polygon or MultiPolygon (holes allowed; or a Feature wrapping one), or a bbox [west, south, east, north]. At most 1 000 vertices, ≤ 50 km across, ≤ 100 km from the target and not containing it.",
  minIlluminated: "Keep only passes with the Moon at least this illuminated, 0 to 1.",
  maxSunAltitude: "Keep only passes with the Sun's true altitude at most this, degrees (e.g. −4 for a dark sky, −6 for after civil dusk).",
}

export const PATH_DOCS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  "/track": {
    start: "First sample, UTC ISO-8601 with Z, on the stepSeconds grid (a multiple of stepSeconds since 1970-01-01T00:00Z; e.g. a whole hour for 1200).",
    end: "Last sample, on the same grid, not before start; at most 8 days after it.",
    stepSeconds: "Sampling step, integer seconds 60 to 3600; at most 1 441 samples. Default 1200 (20 min).",
  },
  "/day": { aim: "Which point of the disc rise and set refer to: upper (default, the almanac convention), center or lower." },
  "/crossing": {
    aim: "Which point of the disc reaches the altitude: center (default), upper, lower, or litCentroid (the centroid of the Moon's lit area; body=moon).",
    start: "Window start, UTC ISO-8601 with Z (with end; at most 31 days). Or give date and tz instead.",
    end: "Window end, UTC ISO-8601 with Z, after start.",
    date: "Instead of start/end: one local date, YYYY-MM-DD (with tz).",
    tz: "IANA time zone for date, e.g. America/New_York.",
    horizonProfile: "Instead of altitude: " + T_PROFILE,
  },
  "/alignment": {
    lat: "Optional fixed spot (with lon): also report when the body passes the target as seen from there (passes, altitudeOffset).",
    lon: "Optional fixed spot (with lat).",
    height: "Your eye's height wherever you stand, metres, measured from heightRef (with msl: above sea level at every standing point). Omitted: the eye at sea level.",
    stepSeconds: "Sampling step, seconds (1 to 3600; at most 2000 steps). Default 60.",
    aim: "Which point of the disc sits on the target: center (default), upper, lower, or litCentroid (the Moon's lit-area centroid, for a partial Moon).",
  },
  "/alignment/search": {
    height: "Your eye's height wherever you stand, metres, measured from heightRef. Omitted: the eye at sea level.",
    start: "Search start, UTC ISO-8601 with Z.",
    end: "Search end, UTC ISO-8601 with Z; at most 400 days after start. Passes whose first entry lies in [start, end).",
    aim: "Which point of the disc sits on the target: center (default), upper, lower, or litCentroid (the Moon's lit-area centroid).",
    include: "Extra context per pass: sun (the Sun's azimuth and true / apparent altitude), phase (the Moon's phase), or sun,phase.",
  },
  "/sightline": {
    lat: "Eye latitude, degrees north, −90 to 90.", lon: "Eye longitude, degrees east, −180 to 180.",
    height: "Eye height, metres, measured from heightRef. Omitted: the eye at sea level.",
    targetHeight: "Target height, metres, measured from targetHeightRef.",
  },
  "/magnetic": { time: "UTC instant, ISO-8601 with Z. Default: now (WMM2025 is valid 2025.0–2030.0; outside it the secular variation is extrapolated)." },
  "/weather": { lat: "Latitude of the point to find stations near, degrees north.", lon: "Longitude, degrees east." },
}

/** The doc for `name` on `path` (the endpoint's own sense if it has one), or undefined for an unknown name. */
export const paramDoc = (path: string, name: string): string | undefined => PATH_DOCS[path]?.[name] ?? PARAM_DOCS[name]
