// The whole EGM96 30′ grid from the source tree (egm96-grid.ts, 373 KB): for tests, the dev server and the R2 upload
// script only. Not exported from index.ts, so it never reaches the Worker bundle (the Worker reads bands from R2).
import { EGM96_30 } from "./egm96-grid.ts"
import type { GeoidBandSource } from "./geoid.ts"

const bytes = EGM96_30.bands.map((s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))
/** Band b's encoded bytes, exactly what R2 holds at the band's range of the geoid object. */
export const bundledGeoidBand: GeoidBandSource = (b) => {
  const x = bytes[b]
  if (!x) throw new RangeError(`no EGM96 band ${b}`)
  return x
}
/** All bands back to back: the R2 object (egm96-bands.ts gives each band's offset and length). */
export const bundledGeoidObject = (): Uint8Array => {
  const out = new Uint8Array(bytes.reduce((s, b) => s + b.length, 0))
  let o = 0
  for (const b of bytes) {
    out.set(b, o)
    o += b.length
  }
  return out
}
