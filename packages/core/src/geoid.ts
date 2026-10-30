// EGM96 geoid undulation N (metres, geoid above the WGS-84 ellipsoid), so that h_ellipsoid = H_msl + N.
// Data: NGA's official 15′ grid (WW15MGH.GRD) subsampled to 30′ (egm96-grid.ts, built by reference/geoid/make_grid.py),
// bilinear between nodes. Interpolation error against NGA's 15′ grid (2 M area-uniform points): rms 0.12 m, p99 0.49 m,
// p99.9 1.06 m, max 3.48 m (steep geoid over trenches and high mountains). Node values are NGA's, rounded to 1 cm.
import { EGM96_30 } from "./egm96-grid.ts"

export const GEOID = {
  model: "EGM96",
  source: "NGA WW15MGH.GRD (15′ grid), subsampled to 30′, bilinear; rounded to 1 cm",
  interpolationErrorM: { rms: 0.12, p99: 0.49, max: 3.48 },
} as const

const { rows, cols, stepDeg, bandRows, bands } = EGM96_30
const grid = new Int16Array(rows * cols)
const decoded = new Uint8Array(bands.length)
/** Decode band b once per isolate (≤ 5 760 nodes): base64 → zigzag varints → planar-predictor residuals → centimetres.
 *  Bands are independent, so a lookup decodes at most two; the whole grid in one stream cost a cold isolate ~7 ms (Node). */
const band = (b: number): void => {
  if (decoded[b]) return
  const bin = atob(bands[b]!), r0 = b * bandRows, r1 = Math.min(r0 + bandRows, rows)
  let p = 0
  for (let i = r0; i < r1; i++) for (let j = 0; j < cols; j++) {
    let z = 0, shift = 0, c: number
    do { c = bin.charCodeAt(p++); z += (c & 0x7f) * 2 ** shift; shift += 7 } while (c & 0x80)
    const r = z % 2 ? -(z + 1) / 2 : z / 2, k = i * cols + j
    const pred = i === r0 ? (j === 0 ? 0 : grid[k - 1]!) : j === 0 ? grid[k - cols]! : grid[k - cols]! + grid[k - 1]! - grid[k - cols - 1]!
    grid[k] = pred + r
  }
  decoded[b] = 1
}
/** Bands decoded so far in this isolate (tests). */
export const geoidBandsDecoded = (): number => decoded.reduce((s, x) => s + x, 0)

/** Geoid undulation (m) at geodetic latitude/longitude (degrees). */
export const geoidUndulation = (lat: number, lon: number): number => {
  const y = Math.min(Math.max((90 - lat) / stepDeg, 0), rows - 1)
  const x = (((lon % 360) + 360) % 360) / stepDeg
  const i = Math.min(Math.floor(y), rows - 2), j = Math.floor(x) % cols, j1 = (j + 1) % cols
  const fy = y - i, fx = x - Math.floor(x)
  band(Math.floor(i / bandRows)); band(Math.floor((i + 1) / bandRows))
  const at = (r: number, c: number) => grid[r * cols + c]! / 100
  return at(i, j) * (1 - fy) * (1 - fx) + at(i, j1) * (1 - fy) * fx + at(i + 1, j) * fy * (1 - fx) + at(i + 1, j1) * fy * fx
}
