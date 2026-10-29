// Observer heights (ellipsoid / MSL via EGM96), the sea-horizon dip, the refraction model down to the horizon, and the
// rise/set threshold. Evidence for every constant: docs/DESIGN.md §7 (ray traces in reference/terrain_sunset).
import { DEG } from "./linalg.ts"
import { geoidUndulation } from "./geoid.ts"
/** Terrestrial refraction coefficient (ray curvature / Earth curvature) and mean Earth radius, shared with /v1/alignment. */
export const K_TERRESTRIAL = 0.13
export const R_MEAN_M = 6_371_008.8

// ─────────────── heights ───────────────
export type HeightRef = "ellipsoid" | "msl"
export interface ObserverHeights {
  readonly heightEllipsoid: number   // m above WGS-84
  readonly heightMsl: number         // m above the EGM96 geoid (≈ mean sea level)
  readonly geoidUndulation: number   // N, m: heightEllipsoid = heightMsl + N
  readonly heightRef: HeightRef | "default"   // what the caller gave; "default" = no height: the observer is on the geoid
}
/** No height → the observer stands on the geoid (sea level); otherwise the height is in `ref` (default: ellipsoid). */
export const observerHeights = (lat: number, lon: number, height: number | undefined, ref: HeightRef | undefined): ObserverHeights => {
  const N = geoidUndulation(lat, lon)
  if (height === undefined) return { heightEllipsoid: N, heightMsl: 0, geoidUndulation: N, heightRef: "default" }
  return (ref ?? "ellipsoid") === "msl"
    ? { heightEllipsoid: height + N, heightMsl: height, geoidUndulation: N, heightRef: "msl" }
    : { heightEllipsoid: height, heightMsl: height - N, geoidUndulation: N, heightRef: "ellipsoid" }
}

// ─────────────── dip of the sea horizon ───────────────
/** Apparent dip of the sea horizon (degrees, ≥ 0) for an eye `hMsl` metres above sea level, in the same terrestrial-refraction
 *  model as /v1/alignment (ray curvature k/R, k = 0.13): dip = √(1 − k) · acos(R / (R + h)), R = 6 371 008.8 m.
 *  ≈ 1.797′·√h for small h. 0 at or below sea level. */
export const seaDip = (hMsl: number): number =>
  hMsl <= 0 ? 0 : Math.sqrt(1 - K_TERRESTRIAL) * Math.acos(R_MEAN_M / (R_MEAN_M + hMsl)) / DEG

export type HorizonSpec = "sea" | "geometric" | number
export interface Horizon { readonly kind: "sea" | "geometric" | "custom"; readonly altitude: number; readonly dip: number | null }
export const horizonOf = (spec: HorizonSpec | undefined, hMsl: number): Horizon => {
  const s = spec ?? "sea"
  if (s === "sea") { const d = seaDip(hMsl); return { kind: "sea", altitude: -d, dip: d } }
  if (s === "geometric") return { kind: "geometric", altitude: 0, dip: null }
  return { kind: "custom", altitude: s, dip: null }
}

// ─────────────── refraction ───────────────
export const T_DEFAULT = 10, P_DEFAULT = 1010
/** Bennett's formula has its maximum at a* = √7.31 − 4.4 (−1.6963°) and decreases below it, which is unphysical: the model's floor. */
export const REFRACTION_FLOOR = Math.sqrt(7.31) - 4.4
export const REFRACTION_CEIL = 89.9
const cotB = (a: number) => 1 / Math.tan((a + 7.31 / (a + 4.4)) * DEG)
/** Bennett (1982) refraction (degrees) for apparent altitude a ∈ [floor, 89.9°], × 0.28·P/(T + 273); 0 above 89.9°. */
export const bennettToFloor = (a: number, T: number, P: number): number =>
  a > REFRACTION_CEIL || a < REFRACTION_FLOOR ? 0 : cotB(a) / 60 * (0.28 * P / (T + 273))
/** Apparent altitude for true altitude h: the fixed point a = h + R(a), or null if it lies below `lowest` (the horizon) or
 *  below the model floor. Above −1° this is exactly Skyfield's `refract` (same iteration, same start). */
export const apparentAltitudeOf = (h: number, T: number, P: number, lowest: number): number | null => {
  const floor = Math.max(lowest, REFRACTION_FLOOR)
  // a − R(a) is increasing in a on [floor, 90], so the fixed point is below `floor` iff h < floor − R(floor).
  if (h < floor - bennettToFloor(floor, T, P)) return null
  let a = Math.max(h, REFRACTION_FLOOR)
  for (let i = 0; i < 100; i++) {
    const next = h + bennettToFloor(a, T, P)
    if (Math.abs(next - a) < 1e-9) { a = next; break }
    a = next
  }
  return a < floor ? null : a
}

/** Rise/set refraction (degrees) at apparent horizon altitude H: the almanac's 34′ at 0°, given Bennett's shape away from 0°,
 *  scaled by pressure and temperature: R = 34′ · (P/1010)·(283/(273 + T)) · cotB(H)/cotB(0). Defaults (10 °C, 1010 hPa,
 *  H = 0) give exactly the old −34′. */
export const riseSetRefraction = (H: number, T: number, P: number): number =>
  (34 / 60) * (P / 1010) * (283 / (273 + T)) * cotB(H) / cotB(0)

export type Limb = "upper" | "center" | "lower"
export const limbSign = (l: Limb): number => (l === "upper" ? 1 : l === "lower" ? -1 : 0)
