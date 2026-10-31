// /v1/position, as a pure function of (blocks, request). Output shape = @ephem/api PositionResponse minus provenance.
import { type BlockSource, type BodyName, bodySsb, earthSsb } from "./ephemeris.ts"
import { type Frame, type Geodetic, angularRadius, apparent, astrometric, ecliptic, enuOf, frameAt, geocentricFrame, topocentric, topocentricRates } from "./observe.ts"
import { litGeometry } from "./aim.ts"
import { apparentAltitudeOf } from "./horizon.ts"
import { DEG, add, dot, mxv, norm, sub, wrap360 } from "./linalg.ts"
import { type Instant, instant, isoMs } from "./time.ts"

export interface PositionInput {
  readonly utcMs: number; readonly geo: Geodetic
  readonly temperature?: number | undefined; readonly pressure?: number | undefined; readonly dut1?: number | undefined
  /** Lowest apparent altitude that gets a refracted value (the observer's horizon); below it apparentAltitude is null. Default 0. */
  readonly horizon?: number | undefined
}

export const PHASE_NAMES = ["new", "waxing crescent", "first quarter", "waxing gibbous", "full", "waning gibbous", "last quarter", "waning crescent"] as const
export type PhaseName = typeof PHASE_NAMES[number]

/** How altitudeRate / azimuthRate are computed, for every endpoint that reports them (observe.ts topocentricRates). */
export const RATE_METHOD = "analytic: DE440 Chebyshev velocity through light time, aberration and Earth rotation (no finite difference)"

const bodyPosition = (src: BlockSource, f: Frame, g: Frame, body: BodyName, T: number, P: number, horizon: number) => {
  const a = apparent(src, f, body)
  const tp = topocentric(f, a.v)
  const ec = ecliptic(g, apparent(src, g, body).v)
  const rates = topocentricRates(src, f, body, a)
  return {
    azimuth: tp.azimuth, altitude: tp.altitude, apparentAltitude: apparentAltitudeOf(tp.altitude, T, P, horizon),
    ...rates,
    rightAscension: tp.rightAscension, declination: tp.declination,
    distanceKm: a.distanceKm, angularRadius: angularRadius(body, a.distanceKm),
    eclipticLongitude: ec.lon, eclipticLatitude: ec.lat,
  }
}

/** Geocentric phase quantities (Skyfield conventions: phase angle from astrometric Moon and un-retarded Sun). */
export const moonPhase = (src: BlockSource, t: Instant) => {
  const g = geocentricFrame(src, t)
  const u = astrometric(src, g, "moon").v                       // Earth → Moon, light-time corrected
  const v = sub(add(earthSsb(src, t.jdTDB).pos, u), bodySsb(src, "sun", t.jdTDB))   // Sun → Moon
  const phaseAngle = Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (norm(u) * norm(v))))) / DEG
  const m = apparent(src, g, "moon").v, s = apparent(src, g, "sun").v
  const elongation = wrap360(ecliptic(g, m).lon - ecliptic(g, s).lon)
  // Bright limb position angle (Meeus 48.5) from geocentric apparent RA/Dec of date
  const ms = topoRaDec(g, m), ss = topoRaDec(g, s)
  const chi = Math.atan2(Math.cos(ss.d) * Math.sin(ss.a - ms.a), Math.sin(ss.d) * Math.cos(ms.d) - Math.cos(ss.d) * Math.sin(ms.d) * Math.cos(ss.a - ms.a))
  return {
    phaseAngle, illuminatedFraction: 0.5 * (1 + Math.cos(phaseAngle * DEG)), elongation,
    brightLimbAngle: wrap360(chi / DEG),
    name: PHASE_NAMES[Math.floor(wrap360(elongation + 22.5) / 45) % 8]!,
  }
}
const topoRaDec = (f: Frame, v: readonly [number, number, number]) => {
  const tp = topocentric(f, v); return { a: tp.rightAscension * 15 * DEG, d: tp.declination * DEG }
}

/** Bright-limb direction seen from this observer, degrees clockwise from the local vertical (towards increasing azimuth):
 *  the Sun's direction from the Moon projected on the sky (topocentric, aim.ts). null with the Moon at the zenith or nadir. */
export const brightLimbFromVertical = (src: BlockSource, f: Frame): number | null => {
  const m = apparent(src, f, "moon"), s = apparent(src, f, "sun")
  return litGeometry(mxv(f.eo.C, m.v), mxv(f.eo.C, s.v), enuOf(f.geo).up, angularRadius("moon", m.distanceKm)).brightLimbAngleFromVertical
}

export const position = (src: BlockSource, input: PositionInput) => {
  const t = instant(input.utcMs, input.dut1 ?? 0)
  const T = input.temperature ?? 10, P = input.pressure ?? 1010, H = input.horizon ?? 0
  const f = frameAt(src, t, input.geo), g = geocentricFrame(src, t)
  return {
    time: { utc: isoMs(t.utcMs), jdTT: t.jdTT, jdUT1: t.jdUT1, dut1: t.dut1, deltaT: t.deltaT },
    observer: { lat: input.geo.lat, lon: input.geo.lon, height: input.geo.height },
    sun: bodyPosition(src, f, g, "sun", T, P, H),
    moon: { ...bodyPosition(src, f, g, "moon", T, P, H), phase: moonPhase(src, t), brightLimbAngleFromVertical: brightLimbFromVertical(src, f) },
  }
}
