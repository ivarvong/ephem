// Observer heights (ellipsoid / MSL via EGM96), the sea-horizon dip, the refraction model down to the horizon, and the
// rise/set threshold. Evidence for every constant: docs/DESIGN.md §7 (ray traces in reference/terrain_sunset).
import { DEG } from "./linalg.ts"
/** Terrestrial refraction coefficient (ray curvature / Earth curvature) and mean Earth radius, shared with /v1/alignment. */
export const K_TERRESTRIAL = 0.13
export const R_MEAN_M = 6_371_008.8

// ─────────────── heights ───────────────
export type HeightRef = "ellipsoid" | "msl"
// observerHeights (ellipsoid / MSL through the EGM96 geoid) lives in geoid.ts: this file (refraction, dip) stays free of the
// geoid, so the browser's bundle of position/track/day (@ephem/web's core module) carries no geoid code or manifest.

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
const COT0 = cotB(0)
/** THE refraction model, used by every endpoint (2026-10-29, ivar: "34′ is fine for now"): degrees of refraction for apparent
 *  altitude a ∈ [floor, 89.9°], 0 above 89.9°:
 *    R(a) = 34′ · (P/1010) · (283/(273 + T)) · cot(a + 7.31/(a + 4.4)) / cot(7.31/4.4)
 *  i.e. Bennett's (1982) shape, normalised to the almanac's 34′ at the horizon for 10 °C / 1010 hPa, with Bennett's P/T scaling.
 *  It is 0.98685 × Bennett-with-Skyfield's-0.28·P/(T + 273) factor at every altitude (0.45′ less at 0°, 0.07′ less at 10°). */
export const refraction = (a: number, T: number, P: number): number =>
  a > REFRACTION_CEIL || a < REFRACTION_FLOOR ? 0 : (34 / 60) * (P / 1010) * (283 / (273 + T)) * (cotB(a) / COT0)
const fixedPoint = (h: number, T: number, P: number): number => {
  let a = Math.max(h, REFRACTION_FLOOR)
  for (let i = 0; i < 100; i++) {
    const next = h + refraction(a, T, P)
    if (Math.abs(next - a) < 1e-9) return next
    a = next
  }
  return a
}
/** Apparent altitude for true altitude h: the fixed point a = h + R(a), or null if it lies below `lowest` (the horizon) or
 *  below the model floor. a − R(a) increases with a on [floor, 90], so the fixed point is below `floor` iff h < floor − R(floor). */
export const apparentAltitudeOf = (h: number, T: number, P: number, lowest: number): number | null => {
  const floor = Math.max(lowest, REFRACTION_FLOOR)
  if (h < floor - refraction(floor, T, P)) return null
  const a = fixedPoint(h, T, P)
  return a < floor ? null : a
}
/** Same model for geometry that needs a number (/v1/alignment's solver): no refraction where the fixed point would lie below
 *  the floor, which alignment never reports (it drops bodies below −1° true). */
export const refractTrue = (h: number, T: number, P: number): number =>
  h < REFRACTION_FLOOR - refraction(REFRACTION_FLOOR, T, P) ? h : fixedPoint(h, T, P)

export type Limb = "upper" | "center" | "lower"
export const limbSign = (l: Limb): number => (l === "upper" ? 1 : l === "lower" ? -1 : 0)
