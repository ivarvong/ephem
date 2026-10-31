// EGM96 geoid: the bundled 30′ grid against NGA's own WW15MGH.GRD and NGA's published test points (fixtures from
// reference/geoid/fetch.sh, read straight from the NGA files, independent of the TS decoder).
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createHash } from "node:crypto"
import { EGM96_BANDS } from "../src/egm96-bands.ts"
import { GEOID, decodeGeoidBand, geoidBandsDecoded, geoidBandsFor, geoidUndulation, observerHeights, setGeoidSource } from "../src/geoid.ts"
import { bundledGeoidBand, bundledGeoidObject } from "../src/geoid-bundled.ts"
import { seaDip } from "../src/horizon.ts"

const fx = JSON.parse(readFileSync(resolve(__dirname, "fixtures/geoid/egm96.json"), "utf8")) as { nodes30: number[][]; ngaTestPoints: number[][]; bilinear15: number[][] }

describe("EGM96 geoid undulation", () => {
  it("a lookup decodes only the bands it touches (first test in the file: nothing decoded before it)", () => {
    expect(geoidBandsDecoded()).toBe(0)
    geoidUndulation(40.7, -74); expect(geoidBandsDecoded()).toBe(1)
    geoidUndulation(90 - 7.5 * 0.5 - 0.1, 10); expect(geoidBandsDecoded()).toBe(3)   // rows 7 and 8 straddle bands 0 and 1
  })
  it("geoidBandsFor names exactly the bands a lookup decodes", () => {
    for (let lat = -90; lat <= 90; lat += 0.0625) {
      const seen = new Set<number>(); setGeoidSource(b => { seen.add(b); return bundledGeoidBand(b) })
      geoidUndulation(lat, 17.3)
      expect([...seen].toSorted((a, b) => a - b), `lat ${lat}`).toEqual(geoidBandsFor(lat))
    }
    setGeoidSource(bundledGeoidBand)
  })
  it("the R2 manifest (egm96-bands.ts) is the bundled grid: offsets, lengths, per-band and object sha256", () => {
    const obj = bundledGeoidObject()
    expect(obj.length).toBe(EGM96_BANDS.bytes)
    expect(createHash("sha256").update(obj).digest("hex")).toBe(EGM96_BANDS.sha256)
    expect(EGM96_BANDS.key).toBe(`egm96-30/${EGM96_BANDS.sha256.slice(0, 16)}.bin`)
    EGM96_BANDS.bands.forEach(([off, len, sha], b) => {
      const x = bundledGeoidBand(b)
      expect(obj.subarray(off, off + len)).toEqual(x)
      expect(createHash("sha256").update(x).digest("hex").slice(0, 16)).toBe(sha)
    })
    expect(EGM96_BANDS.bands.length).toBe(Math.ceil(EGM96_BANDS.rows / EGM96_BANDS.bandRows))
  })
  it("fails closed: no source, a truncated band or trailing bytes throw instead of answering", () => {
    try {
      setGeoidSource(b => { throw new Error(`band ${b} unavailable`) })
      expect(() => geoidUndulation(40.7, -74)).toThrow(/band 12 unavailable/)
    } finally { setGeoidSource(bundledGeoidBand) }
    const x = bundledGeoidBand(12)
    expect(() => decodeGeoidBand(12, x.subarray(0, x.length - 1))).toThrow(/truncated/)
    expect(() => decodeGeoidBand(12, Uint8Array.from([...x, 0]))).toThrow(/trailing/)
  })
  it("every sampled 30′ node equals NGA's WW15MGH.GRD value to the centimetre rounding (≤ 0.005 m)", () => {
    for (const [lat, lon, n] of fx.nodes30) expect(Math.abs(geoidUndulation(lat!, lon! > 180 ? lon! - 360 : lon!) - n!), `${lat},${lon}`).toBeLessThanOrEqual(0.005 + 1e-9)
  })
  it("NGA's published INTPT test points (4×4 spline on the 15′ grid) agree within the stated 30′ interpolation error", () => {
    let worst = 0
    for (const [lat, lon, n] of fx.ngaTestPoints) worst = Math.max(worst, Math.abs(geoidUndulation(lat!, lon!) - n!))
    expect(worst).toBeLessThanOrEqual(0.25)   // measured 0.244 m (−23.6°, 133.9°): the six points are in smooth terrain
  })
  it("against bilinear on NGA's full 15′ grid at 2 000 random points: within the documented rms and max", () => {
    const d = fx.bilinear15.map(([lat, lon, n]) => geoidUndulation(lat!, lon!) - n!)
    const rms = Math.sqrt(d.reduce((s, x) => s + x * x, 0) / d.length), max = Math.max(...d.map(Math.abs))
    expect(rms).toBeLessThanOrEqual(GEOID.interpolationErrorM.rms * 1.5)
    expect(max).toBeLessThanOrEqual(GEOID.interpolationErrorM.max)
  })
  it("wraps in longitude and clamps at the poles", () => {
    expect(geoidUndulation(10, 180)).toBeCloseTo(geoidUndulation(10, -180), 9)
    expect(geoidUndulation(10, 359.9)).toBeCloseTo(geoidUndulation(10, -0.1), 9)
    expect(geoidUndulation(90, 0)).toBeCloseTo(13.61, 2); expect(geoidUndulation(-90, 0)).toBeCloseTo(-29.53, 2)
  })
  it("New York: N ≈ −32.8 m, so 0 m above the ellipsoid is ≈ 33 m above sea level", () => {
    const h = observerHeights(40.7484, -73.9857, 0, "ellipsoid")
    expect(h.geoidUndulation).toBeGreaterThan(-33.5); expect(h.geoidUndulation).toBeLessThan(-32.0)
    expect(h.heightMsl).toBeCloseTo(-h.geoidUndulation, 9)
    const m = observerHeights(40.7484, -73.9857, 320, "msl"); expect(m.heightEllipsoid - m.heightMsl).toBeCloseTo(m.geoidUndulation, 9)
    const none = observerHeights(40.7484, -73.9857, undefined, undefined); expect(none).toMatchObject({ heightMsl: 0, heightRef: "default" })
  })
})

describe("sea-horizon dip", () => {
  it("is √(1 − k)·acos(R/(R + h)): 1.797′·√h for small h, 0 at and below sea level", () => {
    expect(seaDip(0)).toBe(0); expect(seaDip(-20)).toBe(0)
    for (const h of [1, 10, 100, 320, 1000]) expect(seaDip(h) * 60 / Math.sqrt(h)).toBeCloseTo(1.797, 2)
    // vs a US Standard Atmosphere ray trace (reference/terrain_sunset, DESIGN §7): 31.33′ at 320 m; k = 0.13 gives 32.1′
    expect(seaDip(320) * 60).toBeGreaterThan(31.33); expect(seaDip(320) * 60 - 31.33).toBeLessThan(1)
  })
})
