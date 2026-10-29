// Observer on the WGS-84 ellipsoid, light-time, aberration, and the topocentric/ecliptic projections.
import { type BlockSource, type BodyName, AU_KM, C_KM_PER_DAY, bodySsb, earthSsb, nutation } from "./ephemeris.ts"
import { type EarthOrientation, earthOrientation, eclipticMatrix } from "./frames.ts"
import { type Vec3, DEG, add, dot, mtxv, mxv, norm, scale, sub, wrap360 } from "./linalg.ts"
import type { Instant } from "./time.ts"

export const WGS84 = { a: 6378.137, f: 1 / 298.257223563 } as const
const E2 = WGS84.f * (2 - WGS84.f)
const ANGVEL = 7.292115e-5   // rad/s

export interface Geodetic { readonly lat: number; readonly lon: number; readonly height: number }  // deg, deg, metres above ellipsoid

/** WGS-84 geodetic → Earth-fixed (ITRS) position, km. */
export const itrsOf = (g: Geodetic): Vec3 => {
  const la = g.lat * DEG, lo = g.lon * DEG, h = g.height / 1000
  const N = WGS84.a / Math.sqrt(1 - E2 * Math.sin(la) ** 2)
  return [(N + h) * Math.cos(la) * Math.cos(lo), (N + h) * Math.cos(la) * Math.sin(lo), (N * (1 - E2) + h) * Math.sin(la)]
}
/** Local up / north / east unit vectors in ITRS (geodetic normal). */
export const enuOf = (g: Geodetic): { up: Vec3; north: Vec3; east: Vec3 } => {
  const la = g.lat * DEG, lo = g.lon * DEG
  return {
    up: [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)],
    north: [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)],
    east: [-Math.sin(lo), Math.cos(lo), 0],
  }
}

export interface Frame {
  readonly t: Instant
  readonly eo: EarthOrientation
  readonly obsGcrs: Vec3       // observer geocentric position, km (ICRS axes)
  readonly obsSsb: Vec3        // observer barycentric position, km
  readonly obsVelSsb: Vec3     // observer barycentric velocity, km/day (orbital + diurnal)
  readonly geo: Geodetic
}

/** The observer-independent part of a frame: Earth orientation and the geocentre's barycentric state at t. */
export interface Epoch { readonly eo: EarthOrientation; readonly earth: { readonly pos: Vec3; readonly vel: Vec3 } }
export const epochAt = (src: BlockSource, t: Instant): Epoch => {
  const [dpsi, deps] = nutation(src, t.jdTDB)
  return { eo: earthOrientation(t, dpsi, deps), earth: earthSsb(src, t.jdTDB) }
}
export const frameAt = (src: BlockSource, t: Instant, geo: Geodetic, ep: Epoch = epochAt(src, t)): Frame => {
  const { eo, earth } = ep
  const r = itrsOf(geo)
  const vItrs: Vec3 = [-ANGVEL * r[1] * 86400, ANGVEL * r[0] * 86400, 0]   // ω × r, km/day
  const obsGcrs = mtxv(eo.C, r), vGcrs = mtxv(eo.C, vItrs)
  return { t, eo, geo, obsGcrs, obsSsb: add(earth.pos, obsGcrs), obsVelSsb: add(earth.vel, vGcrs) }
}
/** Geocentric frame (observer at the geocentre, no diurnal velocity) for geocentric quantities. */
export const geocentricFrame = (src: BlockSource, t: Instant): Frame => {
  const [dpsi, deps] = nutation(src, t.jdTDB)
  const eo = earthOrientation(t, dpsi, deps)
  const earth = earthSsb(src, t.jdTDB)
  return { t, eo, geo: { lat: 0, lon: 0, height: 0 }, obsGcrs: [0, 0, 0], obsSsb: earth.pos, obsVelSsb: earth.vel }
}

/** Astrometric vector (light-time corrected, km) and light time (days), iterated to convergence like Skyfield; `lt0` seeds the iteration. */
export const astrometric = (src: BlockSource, f: Frame, body: BodyName, lt0 = 0): { v: Vec3; lt: number } => {
  let lt = lt0, v: Vec3 = [0, 0, 0]
  for (let i = 0; i < 10; i++) {
    v = sub(bodySsb(src, body, f.t.jdTDB - lt), f.obsSsb)
    const lt2 = norm(v) / C_KM_PER_DAY
    if (Math.abs(lt2 - lt) < 1e-12) { lt = lt2; break }
    lt = lt2
  }
  return { v, lt }
}

/** Relativistic stellar aberration (NOVAS / Skyfield add_aberration). v and vel in consistent length units; lt in days. */
export const aberrate = (v: Vec3, vel: Vec3, lt: number): Vec3 => {
  const c = C_KM_PER_DAY
  const p1mag = lt * c, vemag = norm(vel), beta = vemag / c
  const cosd = dot(v, vel) / (p1mag * vemag + 1e-300)
  const gammai = Math.sqrt(1 - beta * beta), p = beta * cosd
  const q = (1 + p / (1 + gammai)) * lt
  return scale(add(scale(v, gammai), scale(vel, q)), 1 / (1 + p))
}

/** Apparent (ICRS axes) vector from the observer to the body, km; distance is the astrometric one. */
export const apparent = (src: BlockSource, f: Frame, body: BodyName, lt0 = 0): { v: Vec3; distanceKm: number; lt: number } => {
  const { v, lt } = astrometric(src, f, body, lt0)
  const a = aberrate(v, f.obsVelSsb, lt)
  return { v: a, distanceKm: norm(a), lt }   // Skyfield reports |apparent|; equals |astrometric| to O(β²) (≈ 4 m for the Moon)
}

export interface Topocentric {
  readonly azimuth: number; readonly altitude: number
  readonly rightAscension: number; readonly declination: number   // hours, degrees — of date
  readonly hourAngle: number                                      // hours, (−12, 12]
}
export const topocentric = (f: Frame, v: Vec3): Topocentric => {
  const { up, north, east } = enuOf(f.geo)
  const vItrs = mxv(f.eo.C, v), r = norm(v)
  const u = dot(vItrs, up) / r, n = dot(vItrs, north) / r, e = dot(vItrs, east) / r
  const tod = mxv(f.eo.M, v)
  const ra = Math.atan2(tod[1], tod[0]), dec = Math.asin(tod[2] / norm(tod))
  const ha = ((f.eo.gast + f.geo.lon * DEG - ra) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI
  return {
    azimuth: wrap360(Math.atan2(e, n) / DEG), altitude: Math.asin(u) / DEG,
    rightAscension: wrap360(ra / DEG) / 15, declination: dec / DEG, hourAngle: ha / DEG / 15,
  }
}
export const ecliptic = (f: Frame, v: Vec3): { lon: number; lat: number } => {
  const e = mxv(eclipticMatrix(f.eo), v)
  return { lon: wrap360(Math.atan2(e[1], e[0]) / DEG), lat: Math.asin(e[2] / norm(e)) / DEG }
}

/** Bennett (1982) refraction in degrees for an *apparent* altitude; zero outside [−1°, 89.9°]. */
export const bennett = (apparentAltDeg: number, temperatureC: number, pressureHpa: number): number => {
  if (apparentAltDeg < -1 || apparentAltDeg > 89.9) return 0
  const r = 1 / Math.tan((apparentAltDeg + 7.31 / (apparentAltDeg + 4.4)) * DEG) / 60
  return r * (0.28 * pressureHpa / (temperatureC + 273))
}
/** Apparent altitude from true altitude: the fixed point a = h + bennett(a). Same iteration as Skyfield's `refract`, converged to 1e-9°. */
export const refract = (trueAltDeg: number, temperatureC: number, pressureHpa: number): number => {
  let a = trueAltDeg
  for (let i = 0; i < 50; i++) {
    const next = trueAltDeg + bennett(a, temperatureC, pressureHpa)
    if (Math.abs(next - a) < 1e-9) return next
    a = next
  }
  return a
}

export const SUN_SD_1AU_DEG = 959.63 / 3600
export const MOON_RADIUS_KM = 1737.4
export const angularRadius = (body: BodyName, distanceKm: number): number =>
  body === "sun" ? SUN_SD_1AU_DEG / (distanceKm / AU_KM) : Math.asin(MOON_RADIUS_KM / distanceKm) / DEG
