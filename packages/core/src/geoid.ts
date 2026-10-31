// EGM96 geoid undulation N (metres, geoid above the WGS-84 ellipsoid), so that h_ellipsoid = H_msl + N.
// Data: NGA's official 15′ grid (WW15MGH.GRD) subsampled to 30′ (egm96-grid.ts, built by reference/geoid/make_grid.py),
// bilinear between nodes. Interpolation error against NGA's 15′ grid (2 M area-uniform points): rms 0.12 m, p99 0.49 m,
// p99.9 1.06 m, max 3.48 m (steep geoid over trenches and high mountains). Node values are NGA's, rounded to 1 cm.
//
// The grid is not in the Worker bundle (it was 38% of it, 2026-10-30): its 46 bands of 8 rows live in R2 (egm96-bands.ts
// is their manifest) and reach core through an injected band source. The Worker prefetches the ≤ 2 bands a lookup needs
// (geoidBandsFor) before the pure computation runs; tests and the dev server inject the bundled grid (geoid-bundled.ts).
import { EGM96_BANDS } from "./egm96-bands.ts"
import type { HeightRef } from "./horizon.ts"

export const GEOID = {
  model: "EGM96",
  source: "NGA WW15MGH.GRD (15′ grid), subsampled to 30′, bilinear; rounded to 1 cm",
  interpolationErrorM: { rms: 0.12, p99: 0.49, max: 3.48 },
} as const

const { rows, cols, stepDeg, bandRows } = EGM96_BANDS
export const GEOID_BANDS = EGM96_BANDS.bands.length

/** The encoded bytes of band b (planar-predictor residuals as zigzag varints, egm96-bands.ts). Throws if unavailable. */
export type GeoidBandSource = (band: number) => Uint8Array

let source: GeoidBandSource = (b) => {
  throw new Error(`EGM96 geoid band ${b}: no band source installed (setGeoidSource)`)
}
let decoded: Array<Int16Array | undefined> = []
/** Install where encoded bands come from (once per isolate); forgets every decoded band. */
export const setGeoidSource = (s: GeoidBandSource): void => {
  source = s
  decoded = []
}

/** Decode one band (≤ 5 760 nodes, centimetres): zigzag varints → planar-predictor residuals, restarting at the band's first
 *  row. Throws unless the bytes decode to exactly the band's nodes. */
export const decodeGeoidBand = (b: number, bin: Uint8Array): Int16Array => {
  const n = Math.min(bandRows, rows - b * bandRows),
    g = new Int16Array(n * cols)
  let p = 0
  for (let i = 0; i < n; i++)
    for (let j = 0; j < cols; j++) {
      let z = 0,
        shift = 0,
        c: number
      do {
        if (p >= bin.length) throw new RangeError(`EGM96 band ${b}: truncated at node ${i * cols + j}`)
        c = bin[p++]!
        z += (c & 0x7f) * 2 ** shift
        shift += 7
      } while (c & 0x80)
      const r = z % 2 ? -(z + 1) / 2 : z / 2,
        k = i * cols + j
      const pred =
        i === 0 ? (j === 0 ? 0 : g[k - 1]!) : j === 0 ? g[k - cols]! : g[k - cols]! + g[k - 1]! - g[k - cols - 1]!
      g[k] = pred + r
    }
  if (p !== bin.length) throw new RangeError(`EGM96 band ${b}: ${bin.length - p} trailing bytes`)
  return g
}
const band = (b: number): Int16Array => (decoded[b] ??= decodeGeoidBand(b, source(b)))

/** Bands decoded so far in this isolate (tests). */
export const geoidBandsDecoded = (): number => decoded.filter(Boolean).length

const rowOf = (lat: number) => Math.min(Math.floor(Math.min(Math.max((90 - lat) / stepDeg, 0), rows - 1)), rows - 2)
/** The bands a lookup at this latitude reads (1, or 2 when its two grid rows straddle a band edge). */
export const geoidBandsFor = (lat: number): number[] => {
  const i = rowOf(lat),
    a = Math.floor(i / bandRows),
    b = Math.floor((i + 1) / bandRows)
  return a === b ? [a] : [a, b]
}

/** Geoid undulation (m) at geodetic latitude/longitude (degrees). */
export const geoidUndulation = (lat: number, lon: number): number => {
  const y = Math.min(Math.max((90 - lat) / stepDeg, 0), rows - 1)
  const x = (((lon % 360) + 360) % 360) / stepDeg
  const i = rowOf(lat),
    j = Math.floor(x) % cols,
    j1 = (j + 1) % cols
  const fy = y - i,
    fx = x - Math.floor(x)
  const at = (r: number, c: number) => band(Math.floor(r / bandRows))[(r % bandRows) * cols + c]! / 100
  return (
    at(i, j) * (1 - fy) * (1 - fx) + at(i, j1) * (1 - fy) * fx + at(i + 1, j) * fy * (1 - fx) + at(i + 1, j1) * fy * fx
  )
}

// ─────────────── observer heights ───────────────
export interface ObserverHeights {
  readonly heightEllipsoid: number // m above WGS-84
  readonly heightMsl: number // m above the EGM96 geoid (≈ mean sea level)
  readonly geoidUndulation: number // N, m: heightEllipsoid = heightMsl + N
  readonly heightRef: HeightRef | "default" // what the caller gave; "default" = no height: the observer is on the geoid
}
/** No height → the observer stands on the geoid (sea level); otherwise the height is in `ref` (default: ellipsoid). */
export const observerHeights = (
  lat: number,
  lon: number,
  height: number | undefined,
  ref: HeightRef | undefined,
): ObserverHeights => {
  const N = geoidUndulation(lat, lon)
  if (height === undefined) return { heightEllipsoid: N, heightMsl: 0, geoidUndulation: N, heightRef: "default" }
  return (ref ?? "ellipsoid") === "msl"
    ? { heightEllipsoid: height + N, heightMsl: height, geoidUndulation: N, heightRef: "msl" }
    : { heightEllipsoid: height, heightMsl: height - N, geoidUndulation: N, heightRef: "ellipsoid" }
}
