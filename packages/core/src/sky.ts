// Request-level wrappers for /v1/position, /v1/day and /v1/crossing: resolve heights (EGM96), the horizon and refraction
// inputs, run the pure computation, and state every convention used. Output = the @ephem/api response minus provenance.
import type { BlockSource, BodyName } from "./ephemeris.ts"
import { type Limb, type HeightRef, type HorizonSpec, type ObserverHeights, P_DEFAULT, REFRACTION_CEIL, REFRACTION_FLOOR, T_DEFAULT,
  K_TERRESTRIAL, horizonOf, observerHeights, refraction } from "./horizon.ts"
import { GEOID } from "./geoid.ts"
import { position, RATE_METHOD } from "./position.ts"
import { type HorizonProfile, DAY_THRESHOLDS, MAX_CROSSING_WINDOW_MS, crossing, day, localDay, parseProfile } from "./day.ts"
import { isoMs } from "./time.ts"
import { track } from "./track.ts"
import { CONTEXT_CONVENTIONS, type Include, contextAt } from "./context.ts"
import { type Aim, AIM_DEFINITIONS } from "./aim.ts"

export interface SkyObserverInput { readonly lat: number; readonly lon: number; readonly height?: number | undefined; readonly heightRef?: HeightRef | undefined }
const geoOf = (o: SkyObserverInput) => {
  const h = observerHeights(o.lat, o.lon, o.height, o.heightRef)
  return { h, geo: { lat: o.lat, lon: o.lon, height: h.heightEllipsoid } }
}
const observerOut = (o: SkyObserverInput, h: ObserverHeights) => ({
  lat: o.lat, lon: o.lon, height: h.heightEllipsoid, heightEllipsoid: h.heightEllipsoid, heightMsl: h.heightMsl, geoidUndulation: h.geoidUndulation, heightRef: h.heightRef,
})
const geoidOut = { model: GEOID.model, source: GEOID.source, interpolationErrorM: GEOID.interpolationErrorM }
const RATES = { unit: "deg/min" as const, method: RATE_METHOD }
/** The one refraction model (every endpoint): stated verbatim in every conventions block. */
export const REFRACTION_MODEL = "R(a) = 34′·(P/1010)·(283/(273 + T))·cot(a + 7.31/(a + 4.4))/cot(7.31/4.4) for apparent altitude a (degrees) in [−1.6963°, 89.9°], 0 above: Bennett's (1982) shape normalised to the almanac's 34′ at the horizon (10 °C, 1010 hPa). The same function for /v1/position, /v1/day, /v1/crossing and /v1/alignment."
export const REFRACTION_UNCERTAINTY = "Bennett's shape is fitted to standard-atmosphere tables above 0°; at 0° a US Standard Atmosphere 1976 ray trace (reference/terrain_sunset) gives 33.9′ against this model's 34′. Below 0° it is an extrapolation: at the sea horizon it reads 0.1′ high from 10 m, 1.0′ from 320 m and 2.6′ from 1 000 m against that ray trace. Real refraction near the horizon depends on the temperature profile of the lowest air and varies with the weather by much more than that; treat sub-arcminute differences there as model, not sky."
const horizonOut = (hz: { kind: "sea" | "geometric" | "custom"; altitude: number; dip: number | null } | { kind: "profile"; profile: HorizonProfile }) =>
  hz.kind === "profile"
    ? { kind: "profile" as const, altitude: null, dip: null, terrestrialRefractionK: K_TERRESTRIAL, profile: hz.profile.az.map((a, i) => ({ azimuth: a, elevation: hz.profile.el[i]! })) }
    : { kind: hz.kind, altitude: hz.altitude, dip: hz.dip, terrestrialRefractionK: K_TERRESTRIAL, profile: null }

export type SkyResult<A> = { readonly ok: A } | { readonly error: string }
const floorError = (what: string, H: number, hMsl: number) =>
  `${what} is at ${H.toFixed(4)}° (sea-horizon dip from ${hMsl.toFixed(0)} m above sea level), below the refraction model's floor ${REFRACTION_FLOOR.toFixed(4)}°: pass horizon=geometric, horizon=<degrees ≥ ${REFRACTION_FLOOR.toFixed(4)}> or a horizonProfile`

// ─────────────── /v1/position ───────────────
export interface PositionRequest extends SkyObserverInput {
  readonly utcMs: number; readonly temperature?: number | undefined; readonly pressure?: number | undefined
  readonly horizon?: HorizonSpec | undefined; readonly dut1?: number | undefined
}
export const positionRequest = (src: BlockSource, q: PositionRequest) => {
  const { h, geo } = geoOf(q), T = q.temperature ?? T_DEFAULT, P = q.pressure ?? P_DEFAULT
  const hz = horizonOf(q.horizon, h.heightMsl)
  const r = position(src, { utcMs: q.utcMs, geo, temperature: T, pressure: P, dut1: q.dut1, horizon: hz.altitude })
  return {
    time: r.time, observer: observerOut(q, h), sun: r.sun, moon: r.moon,
    conventions: {
      refraction: { model: REFRACTION_MODEL, temperatureC: T, pressureHpa: P, validFrom: Math.max(hz.altitude, REFRACTION_FLOOR), validTo: 90, uncertainty: REFRACTION_UNCERTAINTY },
      horizon: horizonOut(hz), geoid: geoidOut, rates: RATES,
    },
  }
}

// ─────────────── /v1/track ───────────────
export interface TrackRequest extends SkyObserverInput {
  readonly startMs: number; readonly endMs: number; readonly stepSeconds: number
  readonly temperature?: number | undefined; readonly pressure?: number | undefined; readonly horizon?: HorizonSpec | undefined; readonly dut1?: number | undefined
}
/** The window is validated by the caller (track.ts trackWindowError). */
export const trackRequest = (src: BlockSource, q: TrackRequest) => {
  const { h, geo } = geoOf(q), T = q.temperature ?? T_DEFAULT, P = q.pressure ?? P_DEFAULT
  const hz = horizonOf(q.horizon, h.heightMsl)
  const r = track(src, { startMs: q.startMs, endMs: q.endMs, stepMs: q.stepSeconds * 1000, geo, temperature: T, pressure: P, horizon: hz.altitude, dut1: q.dut1 })
  return {
    start: isoMs(q.startMs), end: isoMs(q.endMs), stepSeconds: q.stepSeconds, count: r.count, observer: observerOut(q, h), sun: r.sun, moon: r.moon,
    conventions: {
      refraction: { model: REFRACTION_MODEL, temperatureC: T, pressureHpa: P, validFrom: Math.max(hz.altitude, REFRACTION_FLOOR), validTo: 90, uncertainty: REFRACTION_UNCERTAINTY },
      horizon: horizonOut(hz), geoid: geoidOut,
    },
  }
}

// ─────────────── /v1/day ───────────────
export interface DayRequest extends SkyObserverInput {
  readonly date: string; readonly tz: string; readonly temperature?: number | undefined; readonly pressure?: number | undefined
  readonly horizon?: HorizonSpec | undefined; readonly horizonProfile?: string | undefined; readonly aim?: Limb | undefined; readonly dut1?: number | undefined
}
type HorizonChoice = { kind: "sea" | "geometric" | "custom"; altitude: number; dip: number | null } | { kind: "profile"; profile: HorizonProfile }
const resolveHorizon = (spec: HorizonSpec | undefined, profile: string | undefined, hMsl: number): SkyResult<HorizonChoice> => {
  if (profile !== undefined) {
    if (spec !== undefined) return { error: "give horizon (sea, geometric or degrees) or horizonProfile (a skyline), not both" }
    const p = parseProfile(profile)
    return typeof p === "string" ? { error: p } : { ok: { kind: "profile", profile: p } }
  }
  const hz = horizonOf(spec, hMsl)
  if (hz.altitude < REFRACTION_FLOOR) return { error: floorError("the horizon", hz.altitude, hMsl) }
  return { ok: hz }
}
export const dayRequest = (src: BlockSource, q: DayRequest): SkyResult<ReturnType<typeof dayOut>> => {
  const w = localDay(q.date, q.tz); if ("error" in w) return w
  const { h, geo } = geoOf(q), T = q.temperature ?? T_DEFAULT, P = q.pressure ?? P_DEFAULT, limb = q.aim ?? "upper"
  const hz = resolveHorizon(q.horizon, q.horizonProfile, h.heightMsl)
  if ("error" in hz) return hz
  const H = hz.ok.kind === "profile" ? hz.ok.profile : hz.ok.altitude
  const r = day(src, { date: q.date, tz: q.tz, geo, dut1: q.dut1, temperature: T, pressure: P, horizon: H, limb })
  return { ok: dayOut(q, h, r, hz.ok, T, P, limb) }
}
const dayOut = (q: DayRequest, h: ObserverHeights, r: ReturnType<typeof day>, hz: HorizonChoice, T: number, P: number, limb: Limb) => {
  const R = hz.kind === "profile" ? null : refraction(hz.altitude, T, P)
  return {
    date: r.date, tz: r.tz, start: r.start, end: r.end, observer: observerOut(q, h), events: r.events,
    conventions: {
      riseSet: {
        aim: { point: limb, definition: AIM_DEFINITIONS[limb] }, definition: `rise/set: the ${limb === "center" ? "centre" : `${limb} limb`} of the Sun or Moon at apparent altitude = the horizon (true limb altitude = horizon − refraction at the horizon)`,
        horizon: horizonOut(hz),
        refraction: { model: REFRACTION_MODEL, temperatureC: T, pressureHpa: P, atHorizon: R },
        trueLimbAltitude: hz.kind === "profile" || R === null ? null : hz.altitude - R,
      },
      transit: "upper culmination: local apparent hour angle = 0",
      twilight: { quantity: "Sun centre true (vacuum) altitude, degrees; independent of height, horizon and refraction", civil: DAY_THRESHOLDS.civil, nautical: DAY_THRESHOLDS.nautical, astronomical: DAY_THRESHOLDS.astronomical },
      goldenHour: { from: DAY_THRESHOLDS.goldenHour[0], to: DAY_THRESHOLDS.goldenHour[1] },
      blueHour: { from: DAY_THRESHOLDS.blueHour[0], to: DAY_THRESHOLDS.blueHour[1] },
      geoid: geoidOut,
    },
  }
}

// ─────────────── /v1/crossing ───────────────
export interface CrossingRequest extends SkyObserverInput {
  readonly startMs: number; readonly endMs: number; readonly body: BodyName
  readonly altitude?: number | undefined; readonly altitudeType?: "true" | "apparent" | undefined; readonly horizonProfile?: string | undefined
  readonly direction?: "rise" | "set" | "either" | undefined
  readonly temperature?: number | undefined; readonly pressure?: number | undefined; readonly dut1?: number | undefined
  readonly include?: ReadonlySet<Include> | undefined   // sun, phase: context per crossing
  readonly aim?: Aim | undefined                        // which point of the disc: center (default), upper, lower, litCentroid (Moon only)
}
/** Window from start/end or from a local date + tz; validation messages are the API's. */
export const crossingWindow = (q: { start?: string | undefined; end?: string | undefined; date?: string | undefined; tz?: string | undefined }): SkyResult<{ startMs: number; endMs: number }> => {
  const byTime = q.start !== undefined || q.end !== undefined, byDate = q.date !== undefined || q.tz !== undefined
  if (byTime === byDate) return { error: "give the window as start and end (UTC, at most 31 days) or as date and tz (one local day): exactly one of the two" }
  if (byTime) {
    if (q.start === undefined || q.end === undefined) return { error: "start and end go together (UTC ISO-8601 with Z, at most 31 days apart)" }
    const a = Date.parse(q.start), b = Date.parse(q.end)
    if (!(b > a)) return { error: `end=${q.end} must be after start=${q.start}` }
    if (b - a > MAX_CROSSING_WINDOW_MS) return { error: `start…end spans ${((b - a) / 86_400_000).toFixed(1)} days; at most 31 days per request` }
    return { ok: { startMs: a, endMs: b } }
  }
  if (q.date === undefined || q.tz === undefined) return { error: "date and tz go together (YYYY-MM-DD and an IANA zone such as America/New_York)" }
  return localDay(q.date, q.tz)
}
export const crossingRequest = (src: BlockSource, q: CrossingRequest): SkyResult<ReturnType<typeof crossingOut>> => {
  if (q.aim === "litCentroid" && q.body !== "moon") return { error: "aim=litCentroid is the Moon's lit-area centroid: it needs body=moon (for the Sun use center, upper or lower)" }
  const { h, geo } = geoOf(q), T = q.temperature ?? T_DEFAULT, P = q.pressure ?? P_DEFAULT
  const limb: Limb = q.aim === undefined || q.aim === "litCentroid" ? "center" : q.aim
  if ((q.altitude === undefined) === (q.horizonProfile === undefined)) return { error: "give the altitude to cross (altitude, degrees) or a skyline (horizonProfile): exactly one" }
  let target: Parameters<typeof crossing>[1]["target"], profile: HorizonProfile | undefined
  if (q.horizonProfile !== undefined) {
    if (q.altitudeType !== undefined) return { error: "altitudeType goes with altitude; a horizonProfile is always apparent (drop altitudeType)" }
    const p = parseProfile(q.horizonProfile); if (typeof p === "string") return { error: p }
    profile = p; target = { kind: "profile", profile: p, temperature: T, pressure: P }
  } else if ((q.altitudeType ?? "true") === "apparent") {
    if (q.altitude! < REFRACTION_FLOOR || q.altitude! > REFRACTION_CEIL) return { error: `an apparent altitude must lie in [${REFRACTION_FLOOR.toFixed(4)}, ${REFRACTION_CEIL}]° (the refraction model's range)` }
    target = { kind: "apparent", altitude: q.altitude!, temperature: T, pressure: P }
  } else target = { kind: "true", altitude: q.altitude! }
  const r = crossing(src, { startMs: q.startMs, endMs: q.endMs, geo, dut1: q.dut1, body: q.body, limb, direction: q.direction ?? "either", target,
    ...(q.aim === "litCentroid" ? { aim: "litCentroid" as const } : {}) })
  const inc = q.include ?? new Set<Include>()
  const withCtx = inc.size === 0 ? r : { crossings: r.crossings.map(c => ({ ...c, ...contextAt(src, inc, geo, h.heightMsl, Date.parse(c.time), { dut1: q.dut1, temperature: T, pressure: P }) })) }
  return { ok: crossingOut(q, h, withCtx, target, limb, profile, T, P) }
}
const crossingOut = (q: CrossingRequest, h: ObserverHeights, r: { crossings: ReadonlyArray<ReturnType<typeof crossing>["crossings"][number] & ReturnType<typeof contextAt>> }, target: Parameters<typeof crossing>[1]["target"], limb: Limb, profile: HorizonProfile | undefined, T: number, P: number) => {
  const what = q.aim === "litCentroid" ? "lit-area centroid" : limb === "center" ? "centre" : `${limb} limb`
  const trueLimb = target.kind === "true" ? target.altitude : target.kind === "apparent" ? target.altitude - refraction(target.altitude, T, P) : null
  return {
    body: q.body, start: isoMs(q.startMs), end: isoMs(q.endMs), observer: observerOut(q, h), crossings: r.crossings,
    conventions: {
      definition: target.kind === "true" ? `the ${what}'s true (vacuum) altitude = ${target.altitude}°`
        : target.kind === "apparent" ? `the ${what}'s apparent altitude = ${target.altitude}° (the one refraction model, as /v1/position and /v1/day)`
        : `the ${what}'s apparent altitude = the horizon profile's elevation at the body's azimuth (the one refraction model, as /v1/position and /v1/day)`,
      aim: { point: q.aim ?? "center", definition: AIM_DEFINITIONS[q.aim ?? "center"] }, altitudeType: target.kind, trueLimbAltitude: trueLimb,
      refraction: target.kind === "true" ? null : { model: REFRACTION_MODEL, temperatureC: T, pressureHpa: P },
      horizon: profile ? horizonOut({ kind: "profile", profile }) : null,
      geoid: geoidOut,
      ...(q.include && q.include.size ? { include: CONTEXT_CONVENTIONS } : {}),
    },
  }
}
