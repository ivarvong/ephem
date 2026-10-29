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

let grid: Int16Array | undefined
/** Decoded once per isolate (260 k nodes): base64 → zigzag varints → planar-predictor residuals → centimetres. */
const nodes = (): Int16Array => {
  if (grid) return grid
  const bin = atob(EGM96_30.data), { rows, cols } = EGM96_30, out = new Int16Array(rows * cols)
  let p = 0
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    let z = 0, shift = 0, b: number
    do { b = bin.charCodeAt(p++); z += (b & 0x7f) * 2 ** shift; shift += 7 } while (b & 0x80)
    const r = z % 2 ? -(z + 1) / 2 : z / 2, k = i * cols + j
    const pred = i === 0 ? (j === 0 ? 0 : out[k - 1]!) : j === 0 ? out[k - cols]! : out[k - cols]! + out[k - 1]! - out[k - cols - 1]!
    out[k] = pred + r
  }
  return (grid = out)
}

/** Geoid undulation (m) at geodetic latitude/longitude (degrees). */
export const geoidUndulation = (lat: number, lon: number): number => {
  const g = nodes(), { rows, cols, stepDeg } = EGM96_30
  const y = Math.min(Math.max((90 - lat) / stepDeg, 0), rows - 1)
  const x = (((lon % 360) + 360) % 360) / stepDeg
  const i = Math.min(Math.floor(y), rows - 2), j = Math.floor(x) % cols, j1 = (j + 1) % cols
  const fy = y - i, fx = x - Math.floor(x)
  const at = (r: number, c: number) => g[r * cols + c]! / 100
  return at(i, j) * (1 - fy) * (1 - fx) + at(i, j1) * (1 - fy) * fx + at(i + 1, j) * fy * (1 - fx) + at(i + 1, j1) * fy * fx
}
