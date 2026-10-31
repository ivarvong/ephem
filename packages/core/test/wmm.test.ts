// WMM2025 against the official test values shipped with the model (WMM2025COF.zip → WMM2025_TestValues.txt).
// Declination is published to 0.01°; X/Y/Z/H/F to 1e-6 nT, so the field components are the sharp check.
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { WMM_COF_ROWS, compassZone, decimalYear, wmm } from "../src/wmm.ts"
const DEG_ = Math.PI / 180

const DIR = resolve(__dirname, "fixtures/wmm2025")
const rows = readFileSync(`${DIR}/WMM2025_TestValues.txt`, "utf8").split("\n").filter(l => l.trim() && !l.startsWith("#")).map(l => l.trim().split(/\s+/).map(Number))
const worst = { D: 0, I: 0, nT: 0, Dxy: 0 }

describe("WMM2025 official test values", () => {
  it("embeds WMM.COF's coefficient rows verbatim", () => {
    const cof = readFileSync(`${DIR}/WMM.COF`, "utf8").split("\n").slice(1).filter(l => l.trim() && !l.startsWith("9999")).map(l => l.trimEnd())
    expect(WMM_COF_ROWS.split("\n")).toEqual(cof)
  })
  it.each(rows.map(r => [`${r[0]} ${r[2]},${r[3]} h=${r[1]}km`, r]) as [string, number[]][])("%s", (_n, r) => {
    const [year, altKm, lat, lon, D, I, H, X, Y, Z, F] = r as [number, number, number, number, number, number, number, number, number, number, number]
    const m = wmm(lat, lon, altKm, year)
    const dD = Math.abs(((m.declination - D + 540) % 360) - 180), dI = Math.abs(m.inclination - I)
    // the published D is rounded to 0.01°; atan2 of the published Y, X (1e-6 nT) is D to ~1e-8°
    const dXY = Math.abs(m.declination - Math.atan2(Y, X) * 180 / Math.PI); worst.Dxy = Math.max(worst.Dxy, dXY); expect(dXY).toBeLessThan(1e-4)
    worst.D = Math.max(worst.D, dD); worst.I = Math.max(worst.I, dI)
    expect(dD).toBeLessThanOrEqual(0.01); expect(dI).toBeLessThanOrEqual(0.01)
    for (const [a, b] of [[m.x, X], [m.y, Y], [m.z, Z], [m.h, H], [m.f, F]] as const) { worst.nT = Math.max(worst.nT, Math.abs(a - b)); expect(Math.abs(a - b)).toBeLessThan(0.01) }
  })
  it("decimal year", () => {
    expect(decimalYear(Date.UTC(2025, 0, 1))).toBe(2025)
    expect(decimalYear(Date.UTC(2026, 6, 2, 12))).toBeCloseTo(2026.5, 3)
  })
  it("report worst deviations", () => { process.stderr.write(`\nWMM2025 vs official test values (n=${rows.length}): |ΔD| ${worst.D.toExponential(2)}°  |ΔD vs atan2(Y,X)| ${worst.Dxy.toExponential(2)}°  |ΔI| ${worst.I.toExponential(2)}°  |Δ XYZHF| ${worst.nT.toExponential(2)} nT\n`) })
})

// Near the poles (sweep 2026-10-31): pygeomag (independent code on NOAA's WMM_2025.COF), frozen by reference/oracle/wmm_poles.py:
// lat ±80…±90 (90 exactly) every 30° of longitude, the dip poles, epochs 2025.0 / 2026.826 / 2029.99, 0 and 5 km.
describe("WMM2025 near the poles vs pygeomag", () => {
  const P = JSON.parse(readFileSync(`${DIR}/poles.json`, "utf8")) as { rows: Array<{ year: number; altKm: number; lat: number; lon: number; d: number; i: number; h: number; f: number; x: number; y: number; z: number; zone: string }> }
  it(`${P.rows.length} points: X, Y, Z, H, F within 0.01 nT (the official test's bar); declination within the bar it implies, 0.01 nT / H`, () => {
    let wnT = 0, wD = 0, wI = 0
    for (const r of P.rows) {
      const m = wmm(r.lat, r.lon, r.altKm, r.year), ctx = `${r.year} ${r.lat},${r.lon} ${r.altKm} km`
      for (const [a, b] of [[m.x, r.x], [m.y, r.y], [m.z, r.z], [m.h, r.h], [m.f, r.f]] as const) { wnT = Math.max(wnT, Math.abs(a - b)); expect(Math.abs(a - b), ctx).toBeLessThan(0.01) }
      const dD = Math.abs(((m.declination - r.d + 540) % 360) - 180); wD = Math.max(wD, dD); wI = Math.max(wI, Math.abs(m.inclination - r.i))
      expect(dD, ctx).toBeLessThanOrEqual(Math.min(0.01, 0.01 / r.h / DEG_))
      expect(Math.abs(m.inclination - r.i), ctx).toBeLessThan(1e-4)
      expect(compassZone(m.h), ctx).toBe(r.zone)   // pygeomag's in_blackout_zone / in_caution_zone
    }
    process.stderr.write(`\nWMM2025 near the poles vs pygeomag (n=${P.rows.length}): |Δ XYZHF| ${wnT.toExponential(2)} nT  |ΔD| ${wD.toExponential(2)}°  |ΔI| ${wI.toExponential(2)}°\n`)
  })
})
