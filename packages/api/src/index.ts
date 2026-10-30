// @ephem/api — the contract. A value, not a server: implementations (the Worker, the Skyfield oracle)
// conform to it, and the cross-check harness compares them field by field.
import * as S from "effect/Schema"
import * as HttpApi from "effect/http-api/HttpApi"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as OpenApi from "effect/http-api/OpenApi"

// ─────────────────────────────── shared conventions ───────────────────────────────
export const CONVENTIONS = {
  frame: "Apparent, topocentric, true equator and equinox of date (light-time, annual + diurnal aberration, precession, nutation).",
  trueAltitude: "Direction in vacuum: no atmospheric refraction.",
  apparentAltitude: "The fixed point a = trueAltitude + R(a) with the one refraction model used by every endpoint: R(a) = 34′·(P/1010)·(283/(273 + T))·cot(a + 7.31/(a + 4.4))/cot(7.31/4.4), i.e. Bennett's (1982) shape normalised to the almanac's 34′ at the horizon (0.98685 × Skyfield's Bennett at every altitude); R = 0 above 89.9°. Defaults T = 10 °C, P = 1010 hPa. Applied down to the observer's horizon (`horizon`, default the sea horizon −dip) but never below −1.6963°, where Bennett's shape peaks; below that, apparentAltitude is null (CHANGED 2026-10-29: it used to repeat the true altitude below −1°, and used Skyfield's unnormalised Bennett, 0.45′ more at 0°). Below 0° the model is an extrapolation: against a US Standard Atmosphere 1976 ray trace it reads 0.1′ high at the sea horizon from 10 m, 1.0′ from 320 m, 2.6′ from 1 000 m, and the real atmosphere near the horizon varies far more than that with the weather.",
  ecliptic: "Geocentric apparent ecliptic longitude/latitude, true equinox and ecliptic of date.",
  height: "`height` is metres above the WGS-84 ellipsoid by default; heightRef=msl makes it metres above the EGM96 geoid (≈ mean sea level). Without a height the observer stands on the geoid. Responses give heightEllipsoid, heightMsl and geoidUndulation N (heightEllipsoid = heightMsl + N; EGM96 from NGA's 15′ grid sampled at 30′, bilinear, rms 0.12 m / max 3.5 m interpolation error).",
  rise: "The chosen limb (default upper) at apparent altitude H, the horizon: H = −dip of the sea horizon for heightMsl (default), 0 (horizon=geometric), a given angle, or a profile by azimuth. Dip = √(1 − k)·acos(R/(R + heightMsl)), k = 0.13 (as /v1/alignment), R = 6 371 008.8 m (≈ 1.80′·√h). True limb altitude at rise/set = H − R(H), R the same refraction model as apparentAltitude (34′ at 0° with defaults, so sea level with defaults is the old −34′ − radius exactly). /v1/crossing at apparent altitude H, upper limb, gives the same instants (≤ 1 ms). Every response's conventions.riseSet gives the numbers used.",
  transit: "Upper culmination: local apparent hour angle = 0.",
  twilight: "Sun centre true altitude crosses −6° (civil), −12° (nautical), −18° (astronomical). Not affected by height, horizon or refraction.",
  goldenHour: "Sun centre true altitude between −4° and +6°.",
  blueHour: "Sun centre true altitude between −6° and −4°.",
  phase: "Geocentric: phase angle Sun–Moon–Earth, illuminated fraction (1 + cos i)/2, elongation = λ☾ − λ☉ in [0, 360).",
  brightLimb: "Position angle of the Moon's bright limb, measured from celestial north through east (Meeus 48.5), geocentric (phase.brightLimbAngle). moon.brightLimbAngleFromVertical is the same limb seen from the observer, degrees clockwise from the local vertical (towards increasing azimuth).",
  aim: "aim (alignment, crossing): which point of the disc is put on the target / altitude. center (default); upper / lower = the limb along the local vertical (topocentric angular radius, asin(1737.4 km / topocentric distance), so parallax is included); litCentroid = the centroid of the Moon's illuminated area: (4r/3π)·(1 − cos i) from the centre towards the bright limb, i the topocentric phase angle, r the angular radius (orthographic disc, parallel sunlight). Offsets are applied in the true sky and the aim point's altitude is then refracted.",
  supportedRange: "1972-01-01T00:00:00Z to 2149-12-31T23:59:59Z (UTC with leap seconds; DE440 coverage).",
  ut1: "UT1 = UTC + dut1 (request parameter, default 0). No polar motion.",
  alignment: "Standing point P solves: body azimuth at P = forward geodesic azimuth P→target, and body apparent altitude at P = target apparent elevation = geometric elevation (exact, WGS-84 ECEF) + k·θ/2 with k = 0.13, θ = geodesic distance / 6 371 008.8 m. Track points are omitted when the body is below −1° or no P lies within maxDistanceKm. Geodesics: WGS-84 (Vincenty/Karney agree to 1 mm here). Heights: observerHeight (heightRef) and targetHeight (targetHeightRef) are above the ellipsoid by default, above the EGM96 geoid with msl; no observerHeight = the eye on the geoid. Every response carries a conventions block (terrestrial refraction, azimuth, refraction, heights, rates).",
  magnetic: "WMM2025 (NOAA NCEI), degree 12 with secular variation; declination east positive; magnetic bearing = true − declination. Verified against the model's published test values.",
  weather: "Nearest METAR stations by great-circle distance from aviationweather.gov's all-stations feed, cached ≤ 60 s fresh, served up to 10 min stale while it refreshes; feed.tier and feed.ageSeconds say which.",
  crossing: "/v1/crossing: every instant in the window when the chosen limb (default centre) reaches `altitude`, true (default) or apparent (the same refraction model as /v1/position and /v1/day), or meets a horizonProfile; rise = upward.",
  rates: "altitudeRate, azimuthRate: degrees per minute, symmetric difference over ±10 s.",
  unknownParameters: "Every endpoint rejects query parameters it does not define with 400 InvalidRequest, listing the allowed ones.",
  track: "/v1/track: the Sun's and Moon's azimuth, true altitude and apparent altitude at every point of a UTC grid (start, end on multiples of stepSeconds since 1970-01-01T00:00Z), columnar; each sample equals /v1/position's values at that instant bit for bit. Bounded: stepSeconds 60–3600, at most 8 days and 1 441 samples.",
  sightline: "/v1/sightline: the sight line's height above sea level against ground distance from an eye to a target (straight chord between WGS-84 ECEF points, so Earth's curvature is included; and the refracted ray with k = 0.13, which runs k·s₁·s₂/(2R) higher), plus each obstacle point's clearance. Terrestrial refraction is modelled as that constant coefficient only.",
  search: "POST /v1/alignment/search (JSON body): every pass in [start, end) (≤ 400 days) when the alignment standing point lies inside a region (GeoJSON Polygon / MultiPolygon with holes, or bbox [w, s, e, n]); segments with exact entry / exit (solved on the track to 1 mm), the Moon's az / alt / illuminated fraction and the Sun's altitude per pass; filters minIlluminated, maxSunAltitude; include sun, phase; aim. Candidates come from the target's elevation and bearing band over the whole region (no representative elevation), scanned with proven rate bounds. Computed per 30-day window (GET /v1/alignment/search/window, immutable), so overlapping scans hit the cache.",
  passes: "With observerLat/Lon: instants when the body's azimuth equals the azimuth to the target (±180° wraps excluded); altitudeOffset tells whether it is above (+) or behind (−) the target top.",
} as const

const Degrees = S.Finite
const Lat = S.Finite.check(S.isBetween({ minimum: -90, maximum: 90 }))
const Lon = S.Finite.check(S.isBetween({ minimum: -180, maximum: 180 }))
const Height = S.Finite.check(S.isBetween({ minimum: -500, maximum: 100_000 }))
const Dut1 = S.Finite.check(S.isBetween({ minimum: -0.9, maximum: 0.9 }))
/** ISO-8601 UTC instant with a trailing Z, millisecond precision or coarser. */
export const UtcString = S.String.check(S.isPattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/))
export const DateString = S.String.check(S.isPattern(/^\d{4}-\d{2}-\d{2}$/))

// Query parameters arrive as strings; FiniteFromString decodes and validates them.
const num = (inner: typeof Degrees) => S.FiniteFromString.pipe(S.decodeTo(inner))
const optNum = (inner: typeof Degrees) => S.optionalKey(num(inner))

// ─────────────────────────────── shared sky parameters ───────────────────────────────
const d0 = (description: string) => ({ description })
/** The refraction model (Bennett's shape) peaks at a* = √7.31 − 4.4 = −1.6963° and falls below it (unphysical): no horizon may lie lower. */
export const REFRACTION_FLOOR_DEG = -1.6963
const Temperature = S.Finite.check(S.isBetween({ minimum: -90, maximum: 60 }))
const Pressure = S.Finite.check(S.isBetween({ minimum: 0, maximum: 1100 }))
export const HeightRef = S.Literals(["ellipsoid", "msl"])
export const Limb = S.Literals(["upper", "center", "lower"])
export const HorizonParam = S.Union([
  S.Literals(["sea", "geometric"]),
  S.FiniteFromString.pipe(S.decodeTo(S.Finite.check(S.isBetween({ minimum: REFRACTION_FLOOR_DEG, maximum: 89 })))),
])
/** "az:el,az:el,…": apparent skyline elevation (degrees, as measured) at azimuths (degrees true, [0, 360)), 1–360 points. */
export const HorizonProfileParam = S.String.check(S.isPattern(/^\s*-?\d+(\.\d+)?:-?\d+(\.\d+)?(\s*,\s*-?\d+(\.\d+)?:-?\d+(\.\d+)?){0,359}\s*$/))
const skyObserverQuery = {
  lat: num(Lat), lon: num(Lon), height: optNum(Height),
  heightRef: S.optionalKey(HeightRef),   // what `height` is measured from; default ellipsoid. No height: the observer is on the geoid (sea level).
}

export const SkyObserver = S.Struct({
  lat: Lat, lon: Lon,
  height: S.Finite.annotate(d0("Metres above the WGS-84 ellipsoid (same as heightEllipsoid; kept for compatibility).")),
  heightEllipsoid: S.Finite, heightMsl: S.Finite.annotate(d0("Metres above the EGM96 geoid (≈ mean sea level).")),
  geoidUndulation: S.Finite.annotate(d0("EGM96 N, metres: heightEllipsoid = heightMsl + geoidUndulation.")),
  heightRef: S.Literals(["ellipsoid", "msl", "default"]).annotate(d0("What the request's height was measured from; default = no height given, the observer is on the geoid.")),
})
export const GeoidConventions = S.Struct({
  model: S.Literal("EGM96"), source: S.String,
  interpolationErrorM: S.Struct({ rms: S.Finite, p99: S.Finite, max: S.Finite }),
})
export const HorizonConventions = S.Struct({
  kind: S.Literals(["sea", "geometric", "custom", "profile"]),
  altitude: S.NullOr(Degrees).annotate(d0("Apparent altitude of the horizon, degrees (null for a profile).")),
  dip: S.NullOr(Degrees).annotate(d0("Sea-horizon dip, degrees: √(1 − k)·acos(R/(R + heightMsl)), k = terrestrialRefractionK, R = 6 371 008.8 m.")),
  terrestrialRefractionK: S.Finite,
  profile: S.NullOr(S.Array(S.Struct({ azimuth: Degrees, elevation: Degrees }))),
})
export const RefractionConventions = S.Struct({
  model: S.String, temperatureC: S.Finite, pressureHpa: S.Finite,
  validFrom: Degrees.annotate(d0("Lowest apparent altitude that gets a value: max(horizon, the model floor −1.6963°). Below it apparentAltitude is null.")),
  validTo: Degrees,
  uncertainty: S.String,
})

// ─────────────────────────────── /v1/position ───────────────────────────────
export const PositionQuery = {
  ...skyObserverQuery,
  time: S.optionalKey(UtcString),                                                    // default: now
  temperature: optNum(Temperature),   // °C, default 10
  pressure: optNum(Pressure),         // hPa, default 1010
  horizon: S.optionalKey(HorizonParam),   // where apparentAltitude stops (becomes null): default sea
  dut1: optNum(Dut1),                                                                 // s, UT1 − UTC, default 0
}

export const TimeInfo = S.Struct({
  utc: UtcString,
  jdTT: S.Finite, jdUT1: S.Finite, dut1: S.Finite, deltaT: S.Finite,   // seconds for dut1 and deltaT (TT − UT1)
})
export const Observer = S.Struct({ lat: Lat, lon: Lon, height: S.Finite })
export const BodyPosition = S.Struct({
  azimuth: Degrees,                // from north through east, [0, 360)
  altitude: Degrees,               // true (vacuum)
  apparentAltitude: S.NullOr(Degrees).annotate(d0("Refracted altitude, degrees; null when it would lie below the observer's horizon or the refraction model's floor (conventions.refraction.validFrom). CHANGED 2026-10-29: was always a number, and repeated the true altitude below −1°.")),
  altitudeRate: S.Finite.annotate(d0("d(altitude)/dt, degrees per minute (true altitude; symmetric difference over ±10 s).")),
  azimuthRate: S.Finite.annotate(d0("d(azimuth)/dt, degrees per minute (symmetric difference over ±10 s).")),
  rightAscension: S.Finite,        // hours, topocentric apparent, of date
  declination: Degrees,            // topocentric apparent, of date
  distanceKm: S.Finite,            // topocentric
  angularRadius: Degrees,          // topocentric
  eclipticLongitude: Degrees,      // geocentric apparent, of date
  eclipticLatitude: Degrees,
})
export const PhaseName = S.Literals(["new", "waxing crescent", "first quarter", "waxing gibbous", "full", "waning gibbous", "last quarter", "waning crescent"])
export const MoonPhase = S.Struct({
  phaseAngle: Degrees, illuminatedFraction: S.Finite, elongation: Degrees, brightLimbAngle: Degrees, name: PhaseName,
})
export const Provenance = S.Struct({
  implementation: S.String, version: S.String, ephemeris: S.String,
  diagnostics: S.optionalKey(S.Struct({ blocks: S.Array(S.Int), computeMs: S.Finite, cache: S.optionalKey(S.Record(S.String, S.Int)) })),
})
export const PositionConventions = S.Struct({
  refraction: RefractionConventions, horizon: HorizonConventions, geoid: GeoidConventions,
  rates: S.Struct({ unit: S.Literal("deg/min"), method: S.String }),
})
export const PositionResponse = S.Struct({
  time: TimeInfo, observer: SkyObserver,
  sun: BodyPosition,
  moon: S.Struct({ ...BodyPosition.fields, phase: MoonPhase,
    brightLimbAngleFromVertical: S.NullOr(Degrees).annotate(d0("Bright limb seen from this observer: degrees clockwise from the local vertical (the direction towards the zenith) as the observer sees the sky, i.e. towards increasing azimuth; topocentric (phase.brightLimbAngle is geocentric, from celestial north through east). = 360° − (χ − q) with χ the topocentric bright-limb position angle and q the parallactic angle. null at the zenith.")) }),
  conventions: PositionConventions,
  provenance: Provenance,
})

// ─────────────────────────────── /v1/day ───────────────────────────────
export const DayQuery = {
  ...skyObserverQuery,
  date: DateString, tz: S.String,   // IANA zone; the day is local midnight to local midnight
  temperature: optNum(Temperature), pressure: optNum(Pressure),   // refraction at the horizon; defaults 10 °C, 1010 hPa
  horizon: S.optionalKey(HorizonParam),                           // sea (default) | geometric | degrees
  horizonProfile: S.optionalKey(HorizonProfileParam),             // instead of horizon: skyline elevation by azimuth
  limb: S.optionalKey(Limb),                                      // which part of the disc rise/set refers to; default upper
  dut1: optNum(Dut1),
}
export const EventKind = S.Literals([
  "rise", "set", "transit",
  "civilDawn", "civilDusk", "nauticalDawn", "nauticalDusk", "astronomicalDawn", "astronomicalDusk",
  "goldenHourStart", "goldenHourEnd", "blueHourStart", "blueHourEnd",
])
export const DayEvent = S.Struct({ time: UtcString, body: S.Literals(["sun", "moon"]), kind: EventKind })
const Band = S.Struct({ from: Degrees, to: Degrees })
export const DayConventions = S.Struct({
  riseSet: S.Struct({
    limb: Limb,
    definition: S.String,
    horizon: HorizonConventions,
    refraction: S.Struct({ model: S.String, temperatureC: S.Finite, pressureHpa: S.Finite,
      atHorizon: S.NullOr(Degrees).annotate(d0("Refraction at the horizon altitude, degrees (null for a profile: it varies with azimuth).")) }),
    trueLimbAltitude: S.NullOr(Degrees).annotate(d0("True (vacuum) altitude of the chosen limb at rise/set = horizon altitude − refraction (null for a profile).")),
  }),
  transit: S.String,
  twilight: S.Struct({ quantity: S.String, civil: Degrees, nautical: Degrees, astronomical: Degrees }),
  goldenHour: Band, blueHour: Band,
  geoid: GeoidConventions,
})
export const DayResponse = S.Struct({
  date: DateString, tz: S.String, start: UtcString, end: UtcString, observer: SkyObserver,
  events: S.Array(DayEvent),          // sorted by time
  conventions: DayConventions,
  provenance: Provenance,
})

// ─────────────────────────────── include=sun,phase (context on crossings and alignments) ───────────────────────────────
export const AimParam = S.Literals(["center", "upper", "lower", "litCentroid"])
const aimFields = {
  aimOffset: S.optionalKey(Degrees.annotate(d0("With aim: angular distance from the disc centre to the aim point, degrees (the angular radius for a limb)."))),
  aimAngle: S.optionalKey(S.NullOr(Degrees).annotate(d0("With aim: direction centre → aim point, degrees clockwise from the local vertical as the observer sees it (0 = upper limb, 180 = lower; litCentroid = the bright limb's direction)."))),
}
/** Comma-separated: sun, phase. */
export const IncludeParam = S.String.check(S.isPattern(/^(sun|phase)(,(sun|phase))?$/))
export const SunContext = S.Struct({
  azimuth: Degrees, altitude: Degrees.annotate(d0("Sun centre true (vacuum) altitude, degrees, seen from this point (twilight thresholds use this).")),
  apparentAltitude: S.NullOr(Degrees).annotate(d0("Refracted, down to the sea horizon at the eye's height; null below it, as /v1/position.")),
})
const contextFields = {
  sun: S.optionalKey(SunContext.annotate(d0("include=sun: the Sun seen from this point at this instant."))),
  phase: S.optionalKey(MoonPhase.annotate(d0("include=phase: the Moon's geocentric phase at this instant, as /v1/position."))),
}

// ─────────────────────────────── /v1/crossing ───────────────────────────────
export const CrossingQuery = {
  ...skyObserverQuery,
  body: S.Literals(["sun", "moon"]),
  altitude: optNum(S.Finite.check(S.isBetween({ minimum: -90, maximum: 90 }))),   // degrees; required unless horizonProfile
  altitudeType: S.optionalKey(S.Literals(["true", "apparent"])),                   // default true (vacuum, like twilight)
  horizonProfile: S.optionalKey(HorizonProfileParam),                               // instead of altitude: apparent skyline by azimuth
  limb: S.optionalKey(Limb),                                                        // default center
  direction: S.optionalKey(S.Literals(["rise", "set", "either"])),                  // default either
  start: S.optionalKey(UtcString), end: S.optionalKey(UtcString),                   // window (≤ 31 days), or:
  date: S.optionalKey(DateString), tz: S.optionalKey(S.String),                     // one local day, like /v1/day
  temperature: optNum(Temperature), pressure: optNum(Pressure), dut1: optNum(Dut1),
  include: S.optionalKey(IncludeParam),                                             // sun,phase: context per crossing
  aim: S.optionalKey(AimParam),                                                     // instead of limb: center | upper | lower | litCentroid (Moon)
}
export const Crossing = S.Struct({
  time: UtcString, direction: S.Literals(["rise", "set"]),
  azimuth: Degrees, altitude: Degrees.annotate(d0("True altitude of the body centre at the crossing.")),
  altitudeRate: S.Finite.annotate(d0("d(true altitude)/dt at the crossing, degrees per minute (±10 s symmetric difference).")),
  ...contextFields, ...aimFields,
})
export const CrossingConventions = S.Struct({
  definition: S.String,
  limb: Limb, altitudeType: S.Literals(["true", "apparent", "profile"]),
  trueLimbAltitude: S.NullOr(Degrees).annotate(d0("True altitude of the chosen limb at the crossing (null for a profile).")),
  refraction: S.NullOr(S.Struct({ model: S.String, temperatureC: S.Finite, pressureHpa: S.Finite })),
  horizon: S.NullOr(HorizonConventions),
  geoid: GeoidConventions,
  include: S.optionalKey(S.String),
  aim: S.optionalKey(S.Struct({ point: AimParam, definition: S.String })),
})
export const CrossingResponse = S.Struct({
  body: S.Literals(["sun", "moon"]), start: UtcString, end: UtcString, observer: SkyObserver,
  crossings: S.Array(Crossing),       // sorted by time
  conventions: CrossingConventions,
  provenance: Provenance,
})

// ─────────────────────────────── /v1/alignment ───────────────────────────────
export const AlignmentQuery = {
  body: S.Literals(["sun", "moon"]),
  targetLat: num(Lat), targetLon: num(Lon),
  targetHeight: num(Height),                 // height of the point to frame (e.g. the torch), metres; see targetHeightRef
  targetHeightRef: S.optionalKey(HeightRef), // what targetHeight is measured from; default ellipsoid
  observerHeight: optNum(Height),            // eye height where you stand, metres; see heightRef. Default: the eye on the geoid (heightMsl 0)
  heightRef: S.optionalKey(HeightRef),       // what observerHeight is measured from; default ellipsoid (as `height` on every endpoint)
  start: UtcString, end: UtcString,
  stepSeconds: optNum(S.Finite.check(S.isBetween({ minimum: 1, maximum: 3600 }))),   // default 60
  maxDistanceKm: optNum(S.Finite.check(S.isBetween({ minimum: 0.01, maximum: 200 }))), // default 20
  temperature: optNum(S.Finite), pressure: optNum(S.Finite), dut1: optNum(Dut1),
  observerLat: optNum(Lat), observerLon: optNum(Lon),   // both or neither: a fixed spot for the converse question
  include: S.optionalKey(IncludeParam),                 // sun,phase: context per track point and per pass
  aim: S.optionalKey(AimParam),                         // which point of the disc sits on the target; default center
}
export const AlignmentPoint = S.Struct({
  time: UtcString,
  lat: Lat, lon: Lon,                 // where to stand
  distanceKm: S.Finite,               // ground distance to the target
  azimuth: Degrees.annotate(d0("The body's azimuth seen from this standing point, degrees true; by construction = the forward geodesic azimuth from here to the target (conventions.azimuth).")),
  apparentAltitude: Degrees.annotate(d0("The body's apparent altitude seen from here = the target's apparent elevation (terrestrial refraction k·θ/2 included), degrees.")),
  angularRadius: Degrees,             // of the body, topocentric, for framing
  altitudeRate: S.Finite.annotate(d0("d(true altitude)/dt of the body seen from this standing point, degrees per minute (±10 s symmetric difference, as /v1/position).")),
  azimuthRate: S.Finite.annotate(d0("d(azimuth)/dt of the body seen from this standing point, degrees per minute (±10 s symmetric difference, as /v1/position).")),
  heightEllipsoid: S.Finite.annotate(d0("The eye's height above WGS-84 at this standing point, metres.")),
  heightMsl: S.Finite.annotate(d0("The eye's height above the EGM96 geoid at this standing point, metres.")),
  geoidUndulation: S.Finite.annotate(d0("EGM96 N at this standing point, metres: heightEllipsoid = heightMsl + geoidUndulation.")),
  ...contextFields, ...aimFields,
})
export const Pass = S.Struct({
  time: UtcString,
  altitudeOffset: Degrees,            // body apparent centre altitude − target apparent elevation (negative: body is hidden behind the target)
  angularRadius: Degrees,
  apparentAltitude: Degrees,
  ...contextFields,
})
export const FromObserver = S.Struct({
  observer: SkyObserver,
  azimuthToTarget: Degrees, distanceKm: S.Finite, targetElevation: Degrees,
  passes: S.Array(Pass),              // instants when the body's azimuth equals the target's, within [start, end]
})
export const AlignmentConventions = S.Struct({
  definition: S.String, azimuth: S.String, apparentAltitude: S.String,
  terrestrialRefraction: S.String.annotate(d0("Whether and how refraction along the sight line (eye → target) is modelled.")),
  heights: S.String, rates: S.String, include: S.optionalKey(S.String),
  aim: S.optionalKey(S.Struct({ point: AimParam, definition: S.String })),
  observerHeightRef: S.Literals(["ellipsoid", "msl", "default"]).annotate(d0("What observerHeight was measured from; default = no observerHeight, the eye is on the geoid.")),
  targetHeightRef: HeightRef,
  terrestrialRefractionK: S.Finite,
  refraction: S.Struct({ model: S.String, temperatureC: S.Finite, pressureHpa: S.Finite }),
  geoid: GeoidConventions,
})
export const AlignmentResponse = S.Struct({
  body: S.Literals(["sun", "moon"]),
  target: SkyObserver.annotate(d0("The target point with its height in both references (heightRef: what targetHeight was measured from).")),
  track: S.Array(AlignmentPoint),
  fromObserver: S.optionalKey(FromObserver),
  conventions: AlignmentConventions,
  provenance: Provenance,
})

// ─────────────────────────────── /v1/sightline ───────────────────────────────
/** "lat:lon:heightMsl,…" (degrees, degrees, metres above sea level), at most 100 points. */
export const ObstaclesParam = S.String.check(S.isPattern(/^\s*-?\d+(\.\d+)?:-?\d+(\.\d+)?:-?\d+(\.\d+)?(\s*,\s*-?\d+(\.\d+)?:-?\d+(\.\d+)?:-?\d+(\.\d+)?){0,99}\s*$/))
export const SightlineQuery = {
  observerLat: num(Lat), observerLon: num(Lon),
  observerHeight: optNum(Height),            // eye height, metres (heightRef); default: the eye on the geoid (heightMsl 0)
  heightRef: S.optionalKey(HeightRef),       // default ellipsoid
  targetLat: num(Lat), targetLon: num(Lon),
  targetHeight: num(Height),                 // metres (targetHeightRef)
  targetHeightRef: S.optionalKey(HeightRef), // default ellipsoid
  samples: S.optionalKey(S.FiniteFromString.pipe(S.decodeTo(S.Int.check(S.isBetween({ minimum: 2, maximum: 1001 }))))),   // default 101
  obstacles: S.optionalKey(ObstaclesParam),  // lat:lon:heightMsl,… (≤ 100): clearance of the line over each
}
export const SightlinePoint = S.Struct({
  distanceKm: S.Finite.annotate(d0("Geodesic ground distance from the observer to the foot of this point.")),
  lat: Lat, lon: Lon,
  heightMsl: S.Finite.annotate(d0("The straight (unrefracted) sight line's height above the EGM96 geoid here, metres; Earth's curvature included.")),
  refractedHeightMsl: S.Finite.annotate(d0("The refracted ray's height here (terrestrial refraction k = 0.13): heightMsl + k·s₁·s₂/(2R).")),
  heightEllipsoid: S.Finite.annotate(d0("The straight line's WGS-84 geodetic height here, metres.")),
  geoidUndulation: S.Finite.annotate(d0("EGM96 N at the foot: heightEllipsoid = heightMsl + geoidUndulation.")),
})
export const SightlineObstacle = S.Struct({
  lat: Lat, lon: Lon, heightMsl: S.Finite,
  distanceKm: S.Finite.annotate(d0("Along the line from the observer (projection).")),
  crossTrackM: S.Finite.annotate(d0("Offset from the line, metres, positive to the right looking at the target.")),
  lineHeightMsl: S.NullOr(S.Finite), refractedLineHeightMsl: S.NullOr(S.Finite),
  clearanceM: S.NullOr(S.Finite).annotate(d0("Straight line − obstacle height, metres; negative = the obstacle is above the line. Null when not between the ends.")),
  refractedClearanceM: S.NullOr(S.Finite),
  blocks: S.NullOr(S.Boolean).annotate(d0("refractedClearanceM < 0.")),
})
export const SightlineResponse = S.Struct({
  observer: SkyObserver, target: SkyObserver,
  distanceKm: S.Finite, azimuth: Degrees.annotate(d0("Forward geodesic azimuth observer → target.")),
  samples: S.Int, profile: S.Array(SightlinePoint), obstacles: S.Array(SightlineObstacle),
  conventions: S.Struct({ definition: S.String, terrestrialRefraction: S.String, obstacles: S.String, heights: S.String, terrestrialRefractionK: S.Finite, geoid: GeoidConventions }),
  provenance: Provenance,
})

// ─────────────────────────────── /v1/track ───────────────────────────────
export const TrackQuery = {
  ...skyObserverQuery,
  start: UtcString, end: UtcString,   // both on the UTC grid of stepSeconds (multiples of it since 1970-01-01T00:00Z), end ≥ start, ≤ 8 days
  stepSeconds: S.optionalKey(S.FiniteFromString.pipe(S.decodeTo(S.Int.check(S.isBetween({ minimum: 60, maximum: 3600 }))))),   // default 1200; at most 1441 samples
  temperature: optNum(Temperature), pressure: optNum(Pressure), horizon: S.optionalKey(HorizonParam), dut1: optNum(Dut1),
}
export const BodyTrack = S.Struct({
  azimuth: S.Array(Degrees).annotate(d0("Degrees from north through east, [0, 360), one per sample.")),
  altitude: S.Array(Degrees).annotate(d0("True (vacuum) altitude, degrees.")),
  apparentAltitude: S.Array(S.NullOr(Degrees)).annotate(d0("Refracted altitude, degrees; null below the observer's horizon or the refraction model's floor, exactly as /v1/position.")),
})
export const TrackConventions = S.Struct({ refraction: RefractionConventions, horizon: HorizonConventions, geoid: GeoidConventions })
export const TrackResponse = S.Struct({
  start: UtcString, end: UtcString,
  stepSeconds: S.Int, count: S.Int.annotate(d0("Samples: sample i is at start + i·stepSeconds; (end − start)/stepSeconds + 1.")),
  observer: SkyObserver,
  sun: BodyTrack, moon: BodyTrack,
  conventions: TrackConventions,
  provenance: Provenance,
})

// ─────────────────────────────── /v1/magnetic, /v1/weather ───────────────────────────────
const d = (description: string) => ({ description })
export const MagneticQuery = {
  lat: num(Lat), lon: num(Lon), height: optNum(Height),   // metres above the ellipsoid, default 0
  time: S.optionalKey(UtcString),                           // default: now
}
export const Magnetic = S.Struct({
  model: S.Literal("WMM2025"),
  declination: Degrees.annotate(d("Magnetic declination, degrees, east positive. Magnetic bearing = true bearing − declination.")),
  inclination: Degrees.annotate(d("Dip, degrees, down positive.")),
  horizontalIntensityNt: S.Finite, totalIntensityNt: S.Finite,
  decimalYear: S.Finite,
  inValidityWindow: S.Boolean.annotate(d("WMM2025 is valid 2025.0–2030.0; outside it the secular variation is extrapolated.")),
})
export const MagneticResponse = S.Struct({ time: UtcString, observer: Observer, magnetic: Magnetic })

export const WeatherQuery = {
  lat: num(Lat), lon: num(Lon),
  n: S.optionalKey(S.FiniteFromString.pipe(S.decodeTo(S.Int.check(S.isBetween({ minimum: 1, maximum: 10 }))))),   // stations, default 1
}
const NumOrNull = S.NullOr(S.Finite)
export const Bearing = S.Struct({
  true: Degrees.annotate(d("Initial great-circle bearing from the observer to the station, degrees true, [0, 360).")),
  magnetic: Degrees.annotate(d("The same bearing, degrees magnetic (true − WMM2025 declination at the observer).")),
})
export const Station = S.Struct({
  stationId: S.String,
  raw: S.String.annotate(d("The METAR exactly as reported (raw_text).")),
  metarType: S.NullOr(S.String), flightCategory: S.NullOr(S.String),
  observationTime: UtcString,
  observationAgeSeconds: S.Finite.annotate(d("now − observation_time.")),
  observationStale: S.Boolean.annotate(d("Observation older than 75 minutes (METARs are hourly).")),
  lat: Lat, lon: Lon, elevationM: NumOrNull,
  distanceKm: S.Finite.annotate(d("Great-circle distance from the observer (sphere of radius 6 371.0088 km).")),
  bearing: Bearing,
  temperatureC: NumOrNull, dewpointC: NumOrNull,
  wind: S.Struct({
    directionDegTrue: NumOrNull.annotate(d("Direction the wind blows from, degrees true; null when calm or variable.")),
    variable: S.Boolean, calm: S.Boolean, speedKt: NumOrNull, gustKt: NumOrNull,
  }),
  visibility: S.Struct({ statuteMiles: NumOrNull, orMore: S.Boolean.annotate(d("Reported as N+ (e.g. 10+): at least N.")) }),
  altimeterInHg: NumOrNull, altimeterHpa: NumOrNull, seaLevelPressureHpa: NumOrNull,
  wx: S.NullOr(S.String).annotate(d("Present weather (wx_string), e.g. -RA BR.")),
  sky: S.Array(S.Struct({ cover: S.String, baseFtAgl: NumOrNull })),
  verticalVisibilityFt: NumOrNull,
})
export const FeedTier = S.Literals(["hit", "miss", "expired", "stale", "updating", "revalidated", "bypass", "dynamic", "none", "stale-on-error"])
export const Feed = S.Struct({
  source: S.String,
  fetchedAt: UtcString.annotate(d("When this Worker last confirmed the feed with aviationweather.gov (200 or 304).")),
  ageSeconds: S.Finite.annotate(d("now − fetchedAt.")),
  lastModified: S.NullOr(UtcString).annotate(d("Upstream Last-Modified of the file.")),
  upstreamAgeSeconds: NumOrNull.annotate(d("now − lastModified.")),
  stale: S.Boolean.annotate(d("Older than the 60 s fresh window (served while a refresh runs, or because upstream failed).")),
  tier: FeedTier.annotate(d("Workers Caching status of the feed fetch, lower-cased cf-cache-status (hit, updating = served stale while it refreshes, miss/expired = fetched from aviationweather.gov, revalidated = 304 from upstream); stale-on-error = the feed fetch failed and this isolate's last copy answered; none = no cache (dev).")),
  stations: S.Int,
})
export const WeatherResponse = S.Struct({
  time: UtcString,
  observer: S.Struct({ lat: Lat, lon: Lon, magneticDeclination: Degrees.annotate(d("WMM2025 at the observer, height 0, now; east positive. Full precision (was rounded to 0.01° before 2026-10-29): the same value /v1/magnetic gives for lat/lon now.")) }),
  stations: S.Array(Station),   // nearest first
  feed: Feed,
})

// ─────────────────────────────── /v1/alignment/search ───────────────────────────────
// One call for "every pass, in a date range, when the alignment standing point is inside a region". The front door
// (POST) validates and canonicalises the request, then fans out to one cached, immutable GET per 30-day window on a fixed
// UTC grid (/v1/alignment/search/window), so repeated and overlapping scans hit Workers Caching; filters run after the cache.
const GeoPosition = S.Array(S.Finite).check(S.isMinLength(2)).annotate(d0("[lon, lat] in degrees (a third element, altitude, is ignored)."))
const BboxMember = S.optionalKey(S.Array(S.Finite))
export const GeoJsonPolygon = S.Struct({ type: S.Literal("Polygon"), coordinates: S.Array(S.Array(GeoPosition)), bbox: BboxMember })
export const GeoJsonMultiPolygon = S.Struct({ type: S.Literal("MultiPolygon"), coordinates: S.Array(S.Array(S.Array(GeoPosition))), bbox: BboxMember })
export const GeoJsonFeature = S.Struct({
  type: S.Literal("Feature"), geometry: S.Union([GeoJsonPolygon, GeoJsonMultiPolygon]),
  properties: S.optionalKey(S.NullOr(S.Unknown)), id: S.optionalKey(S.Union([S.String, S.Finite])), bbox: BboxMember,
})
export const Bbox = S.Tuple([Lon, Lat, Lon, Lat]).annotate(d0("[west, south, east, north], degrees (RFC 7946 bbox order); no antimeridian crossing."))
export const SearchRegion = S.Union([GeoJsonPolygon, GeoJsonMultiPolygon, GeoJsonFeature, Bbox]).annotate(d0(
  "Where you can stand: a GeoJSON Polygon or MultiPolygon (holes allowed; a Feature wrapping one is accepted) or a bbox. Edges are straight lines in (lon, lat) (RFC 7946 §3.1.1); insideness is even-odd per polygon. At most 1 000 vertices and 100 rings, ≤ 50 km across, ≤ 100 km from the target and not containing it. Coordinates are quantised to 1e-7° (≤ 1.1 cm)."))
const Fraction = S.Finite.check(S.isBetween({ minimum: 0, maximum: 1 }))
export const SearchInclude = S.Literals(["sun", "phase"])
export const SearchPayload = S.Struct({
  body: S.Literals(["sun", "moon"]),
  target: S.Struct({
    lat: Lat, lon: Lon,
    height: Height.annotate(d0("Height of the point to frame (e.g. the figure's middle), metres; see heightRef.")),
    heightRef: S.optionalKey(HeightRef.annotate(d0("What target.height is measured from: ellipsoid (default) or msl (EGM96)."))),
  }),
  region: SearchRegion,
  observerHeight: S.optionalKey(Height.annotate(d0("Eye height, metres; see heightRef. Default: the eye on the geoid (heightMsl 0)."))),
  heightRef: S.optionalKey(HeightRef.annotate(d0("What observerHeight is measured from: ellipsoid (default) or msl, in which case the eye is observerHeight + N(P) at every standing point P."))),
  start: UtcString, end: UtcString.annotate(d0("Passes whose first entry lies in [start, end); at most 400 days.")),
  temperature: S.optionalKey(Temperature), pressure: S.optionalKey(Pressure), dut1: S.optionalKey(Dut1),
  aim: S.optionalKey(AimParam.annotate(d0("Which point of the disc sits on the target (as /v1/alignment): center (default), upper, lower, litCentroid (Moon)."))),
  include: S.optionalKey(S.Array(SearchInclude).annotate(d0("Extra context per pass: sun (azimuth, true and apparent altitude) and/or phase (the Moon's full phase block)."))),
  minIlluminated: S.optionalKey(Fraction.annotate(d0("Keep passes whose Moon illuminated fraction (at the pass time) is at least this, 0–1."))),
  maxSunAltitude: S.optionalKey(S.Finite.check(S.isBetween({ minimum: -90, maximum: 90 })).annotate(d0("Keep passes whose Sun centre true altitude (at the pass time, from the standing point) is at most this, degrees; e.g. −4 for a dark sky."))),
})
export const SearchWindowQuery = {
  body: S.Literals(["sun", "moon"]),
  targetLat: num(Lat), targetLon: num(Lon), targetHeight: num(Height), targetHeightRef: S.optionalKey(HeightRef),
  observerHeight: optNum(Height), heightRef: S.optionalKey(HeightRef),
  region: S.String.check(S.isPattern(/^r1\.[A-Za-z0-9_-]+$/)).annotate(d0("The region in the canonical r1 encoding (the POST response's region.encoding).")),
  start: UtcString.annotate(d0("Window start: a multiple of 30 days since 1970-01-01T00:00Z; the window is [start, start + 30 d).")),
  temperature: optNum(Temperature), pressure: optNum(Pressure), dut1: optNum(Dut1),
  aim: S.optionalKey(AimParam),
}
export const SearchCrossing = S.Struct({ time: UtcString, lat: Lat, lon: Lon })
export const SearchSegment = S.Struct({
  enter: SearchCrossing.annotate(d0("Where and when the standing point crosses into the region (a point on a region edge).")),
  exit: SearchCrossing,
})
export const SearchPass = S.Struct({
  time: UtcString.annotate(d0("Midpoint of the pass's first entry and last exit; standingPoint, moon, sunAlt, sun and phase are at this instant.")),
  segments: S.Array(SearchSegment).annotate(d0("Each in-region interval of the ground track, in time order (piers and inlets split a pass).")),
  standingPoint: S.Struct({ lat: Lat, lon: Lon, distanceKm: S.Finite, azimuth: Degrees, apparentAltitude: Degrees }).annotate(d0("The alignment standing point at `time` (may lie between segments, outside the region).")),
  moon: S.Struct({
    az: Degrees.annotate(d0("The Moon's azimuth from the standing point, degrees true.")),
    alt: S.NullOr(Degrees).annotate(d0("The Moon's apparent (refracted) altitude from the standing point, degrees.")),
    illuminated: S.Finite.annotate(d0("Illuminated fraction, 0–1 (geocentric, as /v1/position).")),
    angularRadius: Degrees,
  }),
  sunAlt: Degrees.annotate(d0("The Sun centre's true altitude from the standing point, degrees (twilight convention: −6/−12/−18).")),
  sun: S.optionalKey(S.Struct({ azimuth: Degrees, altitude: Degrees, apparentAltitude: S.NullOr(Degrees) })),
  phase: S.optionalKey(MoonPhase),
})
export const SearchGeometry = S.Struct({
  reference: S.Struct({ lat: Lat, lon: Lon }).annotate(d0("The region's bbox centre, where the scan looks at the body.")),
  distanceM: S.Struct({ min: S.Finite, max: S.Finite }).annotate(d0("Nearest and farthest region points from the target, metres (exact WGS-84 geodesics).")),
  elevation: S.Struct({ min: Degrees, max: Degrees }).annotate(d0("The target's apparent elevation over the whole region at the eye height, degrees: the band the body's apparent altitude must be in.")),
  azimuth: S.Struct({ min: Degrees, max: Degrees }).annotate(d0("Forward azimuths from the region to the target, degrees true.")),
  band: S.Struct({ trueAltitudeMin: Degrees, trueAltitudeMax: Degrees, azimuthMin: Degrees, azimuthMax: Degrees }).annotate(d0("The same band for the body seen from the reference point, as true altitude, margins included.")),
  margins: S.Struct({ altitude: Degrees, azimuth: Degrees }),
  maxDistanceKm: S.Finite, referenceSpreadM: S.Finite,
})
export const SearchCounters = S.Record(S.String, S.Finite).annotate(d0("Work counts: scanEvaluations, spans, spanSeconds, trackEvaluations, crossings, refineEvaluations, segments, anomalies (0 unless an invariant failed), maxSagittaM."))
export const SearchRegionInfo = S.Struct({
  encoding: S.String.annotate(d0("Canonical r1 encoding: the cache key part for the region (window GETs carry it).")),
  polygons: S.Int, rings: S.Int, vertices: S.Int,
  bbox: S.Tuple([Lon, Lat, Lon, Lat]),
  geoidUndulation: S.Struct({ min: S.Finite, max: S.Finite }).annotate(d0("EGM96 N over the region's vertices, metres.")),
})
export const SearchConventions = S.Struct({
  definition: S.String, region: S.String, segments: S.String, passes: S.String, candidates: S.String, windows: S.String, filters: S.String,
  azimuth: S.String, terrestrialRefraction: S.String, heights: S.String,
  observerHeightRef: S.Literals(["ellipsoid", "msl", "default"]), targetHeightRef: HeightRef,
  terrestrialRefractionK: S.Finite,
  refraction: S.Struct({ model: S.String, temperatureC: S.Finite, pressureHpa: S.Finite }),
  geoid: GeoidConventions,
  aim: S.optionalKey(S.Struct({ point: AimParam, definition: S.String })),
})
const SearchObserver = S.Struct({
  observerHeight: S.Finite.annotate(d0("As given (0 with heightRef msl when omitted: the eye on the geoid).")),
  heightRef: S.Literals(["ellipsoid", "msl", "default"]),
})
export const SearchWindowResponse = S.Struct({
  body: S.Literals(["sun", "moon"]), start: UtcString, end: UtcString,
  target: SkyObserver, observer: SearchObserver, region: SearchRegionInfo,
  passes: S.Array(SearchPass).annotate(d0("Passes whose first entry lies in [start, end), every field (sun and phase included).")),
  geometry: SearchGeometry, counters: SearchCounters,
  conventions: SearchConventions,
  provenance: Provenance,
})
export const SearchResponse = S.Struct({
  body: S.Literals(["sun", "moon"]), start: UtcString, end: UtcString,
  target: SkyObserver, observer: SearchObserver, region: SearchRegionInfo,
  passes: S.Array(SearchPass).annotate(d0("Passes whose first entry lies in [start, end) and that pass the filters, in time order.")),
  search: S.Struct({
    geometry: SearchGeometry,
    windows: S.Array(S.Struct({ start: UtcString, end: UtcString, passes: S.Int, cache: S.String.annotate(d0("Workers Caching status of this window's GET (HIT, MISS, …; LOCAL when computed in-process).")) })),
    passesBeforeFilters: S.Int,
    counters: SearchCounters.annotate(d0("Summed over the windows computed for this answer (cache hits report the counts of the run that filled them).")),
  }),
  conventions: SearchConventions,
  provenance: Provenance,
})

// ─────────────────────────────── errors ───────────────────────────────
export class OutOfRange extends S.TaggedError<OutOfRange>()("OutOfRange", { message: S.String }, { httpApiStatus: 422 }) {}
export class InvalidInput extends S.TaggedError<InvalidInput>()("InvalidInput", { message: S.String }, { httpApiStatus: 422 }) {}
/** The EGM96 geoid band an observer's height needs could not be loaded (fail closed: no guessed height). */
export class GeoidUnavailable extends S.TaggedError<GeoidUnavailable>()("GeoidUnavailable", { message: S.String }, { httpApiStatus: 503 }) {}
export class WeatherUnavailable extends S.TaggedError<WeatherUnavailable>()("WeatherUnavailable", { message: S.String }, { httpApiStatus: 503 }) {}

// ─────────────────────────────── the API value ───────────────────────────────
export const SkyGroup = HttpApiGroup.make("sky").add(
  HttpApiEndpoint.get("position", "/v1/position", { query: PositionQuery, success: PositionResponse, error: [OutOfRange, InvalidInput, GeoidUnavailable] }),
  HttpApiEndpoint.get("day", "/v1/day", { query: DayQuery, success: DayResponse, error: [OutOfRange, InvalidInput, GeoidUnavailable] }),
  HttpApiEndpoint.get("crossing", "/v1/crossing", { query: CrossingQuery, success: CrossingResponse, error: [OutOfRange, InvalidInput, GeoidUnavailable] }),
  HttpApiEndpoint.get("alignment", "/v1/alignment", { query: AlignmentQuery, success: AlignmentResponse, error: [OutOfRange, InvalidInput, GeoidUnavailable] }),
  HttpApiEndpoint.get("sightline", "/v1/sightline", { query: SightlineQuery, success: SightlineResponse, error: [InvalidInput, GeoidUnavailable] }),
  HttpApiEndpoint.get("track", "/v1/track", { query: TrackQuery, success: TrackResponse, error: [OutOfRange, InvalidInput, GeoidUnavailable] }),
)
/** Unknown body fields are rejected like unknown query parameters. */
export const SearchGroup = HttpApiGroup.make("search").add(
  HttpApiEndpoint.post("search", "/v1/alignment/search", { payload: SearchPayload, success: SearchResponse, error: [OutOfRange, InvalidInput, GeoidUnavailable] })
    .annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" }),
  HttpApiEndpoint.get("searchWindow", "/v1/alignment/search/window", { query: SearchWindowQuery, success: SearchWindowResponse, error: [OutOfRange, InvalidInput, GeoidUnavailable] }),
)
export const EarthGroup = HttpApiGroup.make("earth").add(
  HttpApiEndpoint.get("magnetic", "/v1/magnetic", { query: MagneticQuery, success: MagneticResponse, error: [OutOfRange, InvalidInput] }),
  HttpApiEndpoint.get("weather", "/v1/weather", { query: WeatherQuery, success: WeatherResponse, error: [WeatherUnavailable] }),
)
export const MetaGroup = HttpApiGroup.make("meta").add(
  HttpApiEndpoint.get("health", "/healthz", { success: S.Struct({ ok: S.Literal(true), implementation: S.String, version: S.String }) }),
)
export const API_DESCRIPTION = [
  "Sun and Moon positions, day events, crossings and alignments from JPL DE440. Every response carries provenance (implementation, ephemeris, DE440 blocks read, compute time, cache tiers) and, for /v1/position, /v1/day, /v1/crossing and /v1/alignment, a conventions block with every threshold, horizon, refraction input and geoid value used.",
  "",
  "Changes on 2026-10-29 (API correctness pass):",
  "1. /v1/day rise and set now depend on height. An explicit `height` is metres above the WGS-84 ellipsoid (unchanged meaning), and the sea-horizon dip is taken from the height above mean sea level (EGM96). Example: in New York `height=0` is ≈ 33 m above sea level, so sunrise is ≈ 1 min earlier and sunset ≈ 1 min later than before. Pass `heightRef=msl` for a height above sea level (iOS `altitude`, maps); omit `height` to stand at sea level, which gives the previous times (Sun within 1 ms).",
  "2. `apparentAltitude` in /v1/position is now `number | null`: refraction is applied down to the observer's horizon (default the sea horizon, −dip) and the value is null below it or below −1.6963°. It used to repeat the true altitude below −1°. One refraction model now serves every endpoint (34′ at the horizon), so apparent altitudes are 1.3 % of the refraction lower than Skyfield's Bennett (0.45′ at 0°, 0.07′ at 10°), and /v1/crossing at apparent 0° (upper limb) equals /v1/day's sunrise.",
  "3. Unknown query parameters are rejected with 400 InvalidRequest (kind UnknownParameter, with the allowed list). They used to be ignored.",
  "4. New: /v1/crossing; on /v1/day `temperature`, `pressure`, `horizon` (sea | geometric | degrees), `horizonProfile`, `limb`; `heightRef` everywhere; `altitudeRate` and `azimuthRate` (°/min) in positions; observer heightMsl and geoidUndulation.",
  "5. New (2026-10-29): /v1/track, the sampled Sun and Moon azimuth / altitude / apparent altitude over a UTC grid in one immutable answer (what the homepage draws its paths from).",
  "",
  "Changes on 2026-10-30 (round-2 feedback):",
  "6. /v1/alignment: `heightRef` (observer) and `targetHeightRef`, each ellipsoid (default) | msl, as on /v1/crossing; `target` echoes the target's heights and geoid undulation; every track point has `altitudeRate`, `azimuthRate` (°/min, as /v1/position), `heightEllipsoid`, `heightMsl`, `geoidUndulation`; a `conventions` block. BEHAVIOUR CHANGE: without `observerHeight` the eye is now on the geoid (heightMsl 0, as on every other endpoint); it used to be 0 m above the ellipsoid (≈ 33 m below sea level in New York).",
  "7. `include=sun,phase` on /v1/alignment (per track point and pass) and /v1/crossing (per crossing): the Sun's azimuth, true and apparent altitude seen from that point, and the Moon's phase.",
  "8. `aim=center|upper|lower|litCentroid` on /v1/alignment and /v1/crossing (litCentroid: the Moon's lit-area centroid, (4r/3π)(1 − cos i) towards the bright limb), with aimOffset/aimAngle per point; /v1/position moon.brightLimbAngleFromVertical (clockwise from the local vertical, topocentric). BEHAVIOUR CHANGE: none for existing queries (aim defaults to center).",
  "9. New: /v1/sightline (the sight line's height above sea level against distance, with Earth curvature and k = 0.13 refraction, and obstacle clearances). /docs is plain HTML (no JavaScript needed); /llms.txt; the Scalar reference moved to /docs/interactive.",
  "10. New: POST /v1/alignment/search — every pass in [start, end) (≤ 400 days) during which the alignment standing point lies inside a standing region (GeoJSON Polygon / MultiPolygon with holes, or a bbox), with exact entry and exit points (solved on the track to 1 mm, not sampled), the Moon's azimuth / altitude / illumination and the Sun's altitude per pass, optional filters (minIlluminated, maxSunAltitude) and include=sun,phase. Candidates come from the target's elevation band over the whole region, not one representative elevation. Computed per 30-day window (GET /v1/alignment/search/window, immutable and cached), so overlapping scans share work.",
].join("\n")

/** Unknown query parameters are an error, not silently ignored (a dropped `temperature` changes nothing and says nothing). */
export const EphemApi = HttpApi.make("ephem").add(SkyGroup, SearchGroup, EarthGroup, MetaGroup)
  .annotate(HttpApi.QueryParseOptions, { onExcessProperty: "error" })
  .annotate(OpenApi.Description, API_DESCRIPTION)
/** The allowed query parameters per path, from the endpoint schemas (for error messages). */
export const QUERY_PARAMS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "/v1/position": Object.keys(PositionQuery), "/v1/day": Object.keys(DayQuery), "/v1/crossing": Object.keys(CrossingQuery),
  "/v1/alignment": Object.keys(AlignmentQuery), "/v1/sightline": Object.keys(SightlineQuery), "/v1/alignment/search/window": Object.keys(SearchWindowQuery), "/v1/track": Object.keys(TrackQuery), "/v1/magnetic": Object.keys(MagneticQuery), "/v1/weather": Object.keys(WeatherQuery), "/healthz": [],
}

export type PositionResponse = typeof PositionResponse.Type
export type DayResponse = typeof DayResponse.Type
export type CrossingResponse = typeof CrossingResponse.Type
export type AlignmentResponse = typeof AlignmentResponse.Type
export type SightlineResponse = typeof SightlineResponse.Type
export type SearchResponse = typeof SearchResponse.Type
export type SearchWindowResponse = typeof SearchWindowResponse.Type
export type SearchPayload = typeof SearchPayload.Type
export type TrackResponse = typeof TrackResponse.Type
export type BodyPosition = typeof BodyPosition.Type
export type WeatherResponse = typeof WeatherResponse.Type
export type MagneticResponse = typeof MagneticResponse.Type
