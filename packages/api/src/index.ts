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
  brightLimb: "Position angle of the Moon's bright limb, measured from celestial north through east (Meeus 48.5).",
  supportedRange: "1972-01-01T00:00:00Z to 2149-12-31T23:59:59Z (UTC with leap seconds; DE440 coverage).",
  ut1: "UT1 = UTC + dut1 (request parameter, default 0). No polar motion.",
  alignment: "Standing point P solves: body azimuth at P = forward geodesic azimuth P→target, and body apparent altitude at P = target apparent elevation = geometric elevation (exact, WGS-84 ECEF) + k·θ/2 with k = 0.13, θ = geodesic distance / 6 371 008.8 m. Track points are omitted when the body is below −1° or no P lies within maxDistanceKm. Geodesics: WGS-84 (Vincenty/Karney agree to 1 mm here). Heights: observerHeight (heightRef) and targetHeight (targetHeightRef) are above the ellipsoid by default, above the EGM96 geoid with msl; no observerHeight = the eye on the geoid. Every response carries a conventions block (terrestrial refraction, azimuth, refraction, heights, rates).",
  magnetic: "WMM2025 (NOAA NCEI), degree 12 with secular variation; declination east positive; magnetic bearing = true − declination. Verified against the model's published test values.",
  weather: "Nearest METAR stations by great-circle distance from aviationweather.gov's all-stations feed, cached ≤ 60 s fresh, served up to 10 min stale while it refreshes; feed.tier and feed.ageSeconds say which.",
  crossing: "/v1/crossing: every instant in the window when the chosen limb (default centre) reaches `altitude`, true (default) or apparent (the same refraction model as /v1/position and /v1/day), or meets a horizonProfile; rise = upward.",
  rates: "altitudeRate, azimuthRate: degrees per minute, symmetric difference over ±10 s.",
  unknownParameters: "Every endpoint rejects query parameters it does not define with 400 InvalidRequest, listing the allowed ones.",
  track: "/v1/track: the Sun's and Moon's azimuth, true altitude and apparent altitude at every point of a UTC grid (start, end on multiples of stepSeconds since 1970-01-01T00:00Z), columnar; each sample equals /v1/position's values at that instant bit for bit. Bounded: stepSeconds 60–3600, at most 8 days and 1 441 samples.",
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
  moon: S.Struct({ ...BodyPosition.fields, phase: MoonPhase }),
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
}
export const Crossing = S.Struct({
  time: UtcString, direction: S.Literals(["rise", "set"]),
  azimuth: Degrees, altitude: Degrees.annotate(d0("True altitude of the body centre at the crossing.")),
  altitudeRate: S.Finite.annotate(d0("d(true altitude)/dt at the crossing, degrees per minute (±10 s symmetric difference).")),
  ...contextFields,
})
export const CrossingConventions = S.Struct({
  definition: S.String,
  limb: Limb, altitudeType: S.Literals(["true", "apparent", "profile"]),
  trueLimbAltitude: S.NullOr(Degrees).annotate(d0("True altitude of the chosen limb at the crossing (null for a profile).")),
  refraction: S.NullOr(S.Struct({ model: S.String, temperatureC: S.Finite, pressureHpa: S.Finite })),
  horizon: S.NullOr(HorizonConventions),
  geoid: GeoidConventions,
  include: S.optionalKey(S.String),
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
  ...contextFields,
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
  HttpApiEndpoint.get("track", "/v1/track", { query: TrackQuery, success: TrackResponse, error: [OutOfRange, InvalidInput, GeoidUnavailable] }),
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
].join("\n")

/** Unknown query parameters are an error, not silently ignored (a dropped `temperature` changes nothing and says nothing). */
export const EphemApi = HttpApi.make("ephem").add(SkyGroup, EarthGroup, MetaGroup)
  .annotate(HttpApi.QueryParseOptions, { onExcessProperty: "error" })
  .annotate(OpenApi.Description, API_DESCRIPTION)
/** The allowed query parameters per path, from the endpoint schemas (for error messages). */
export const QUERY_PARAMS: Readonly<Record<string, ReadonlyArray<string>>> = {
  "/v1/position": Object.keys(PositionQuery), "/v1/day": Object.keys(DayQuery), "/v1/crossing": Object.keys(CrossingQuery),
  "/v1/alignment": Object.keys(AlignmentQuery), "/v1/track": Object.keys(TrackQuery), "/v1/magnetic": Object.keys(MagneticQuery), "/v1/weather": Object.keys(WeatherQuery), "/healthz": [],
}

export type PositionResponse = typeof PositionResponse.Type
export type DayResponse = typeof DayResponse.Type
export type CrossingResponse = typeof CrossingResponse.Type
export type AlignmentResponse = typeof AlignmentResponse.Type
export type TrackResponse = typeof TrackResponse.Type
export type BodyPosition = typeof BodyPosition.Type
export type WeatherResponse = typeof WeatherResponse.Type
export type MagneticResponse = typeof MagneticResponse.Type
