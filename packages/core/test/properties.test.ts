// Invariants that hold regardless of the oracle: geometry, monotonicity, round trips, and alignment self-consistency.
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { position } from "../src/position.ts"
import { day, crossings } from "../src/day.ts"
import { alignment, targetElevation } from "../src/alignment.ts"
import { apparent, frameAt, topocentric } from "../src/observe.ts"
import { REFRACTION_FLOOR, apparentAltitudeOf, refraction, refractTrue as refract, seaDip } from "../src/horizon.ts"
import { crossingRequest, dayRequest, positionRequest } from "../src/sky.ts"
import { profileAt, parseProfile } from "../src/day.ts"
import { instant, taiMinusUtc } from "../src/time.ts"
import { diskBlocks } from "./helpers/blocks.ts"
import { readFileSync } from "node:fs"

// Instants restricted to the blocks shipped as fixtures (offline), spread over 1972–2149.
const fixtureMs = [...new Set(JSON.parse(readFileSync(`${__dirname}/fixtures/oracle.json`, "utf8")).position.map((c: any) => Date.parse(c.query.time)))] as number[]
const arbMs = fc.constantFrom(...fixtureMs).chain(ms => fc.integer({ min: -3 * 3600_000, max: 3 * 3600_000 }).map(d => ms + d))
const arbGeo = fc.record({ lat: fc.double({ min: -89.9, max: 89.9, noNaN: true }), lon: fc.double({ min: -180, max: 180, noNaN: true }), height: fc.double({ min: -100, max: 5000, noNaN: true }) })

describe("position invariants", () => {
  it("ranges, refraction direction, limb geometry", () => {
    fc.assert(fc.property(arbMs, arbGeo, (ms, geo) => {
      const r = position(diskBlocks, { utcMs: ms, geo })
      for (const b of [r.sun, r.moon]) {
        expect(b.azimuth).toBeGreaterThanOrEqual(0); expect(b.azimuth).toBeLessThan(360)
        expect(Math.abs(b.altitude)).toBeLessThanOrEqual(90)
        if (b.apparentAltitude === null) expect(b.altitude).toBeLessThan(0)                  // null only below the (default, geometric) horizon
        else {
          expect(b.apparentAltitude).toBeGreaterThanOrEqual(0 - 1e-12)                          // never below the horizon it was given
          expect(b.apparentAltitude).toBeGreaterThanOrEqual(b.altitude - 1e-12)                 // refraction only lifts
          expect(b.apparentAltitude - b.altitude).toBeLessThanOrEqual(0.7)                      // 34′ at 0°
        }
        expect(b.rightAscension).toBeGreaterThanOrEqual(0); expect(b.rightAscension).toBeLessThan(24)
      }
      expect(r.sun.angularRadius).toBeGreaterThan(0.26); expect(r.sun.angularRadius).toBeLessThan(0.272)
      expect(r.moon.angularRadius).toBeGreaterThan(0.24); expect(r.moon.angularRadius).toBeLessThan(0.285)
      expect(r.moon.distanceKm).toBeGreaterThan(350_000); expect(r.moon.distanceKm).toBeLessThan(420_000)
      const p = r.moon.phase
      expect(Math.abs(p.illuminatedFraction - 0.5 * (1 + Math.cos(p.phaseAngle * Math.PI / 180)))).toBeLessThan(1e-12)
      // Elongation and phase angle are nearly supplementary (exactly so for a coplanar Moon)
      expect(Math.abs(Math.abs(180 - p.elongation) - p.phaseAngle)).toBeLessThan(5.5)
    }), { numRuns: 150 })
  })
  it("topocentric altitude never exceeds the geocentric view by more than the horizontal parallax", () => {
    fc.assert(fc.property(arbMs, arbGeo, (ms, geo) => {
      const r = position(diskBlocks, { utcMs: ms, geo }), r0 = position(diskBlocks, { utcMs: ms, geo: { ...geo, height: 0 } })
      expect(Math.abs(r.moon.altitude - r0.moon.altitude)).toBeLessThan(0.05)   // 5 km of height ≈ 0.04° of lunar parallax
    }), { numRuns: 40 })
  })
})

describe("refraction down to the horizon (2026-10-29)", () => {
  it("is Bennett's (1982) shape scaled to 34′ at 0°: a constant 0.987 × Skyfield's Bennett at every altitude, T and P", () => {
    const bennett = (a: number, T: number, P: number) => (1 / Math.tan((a + 7.31 / (a + 4.4)) * Math.PI / 180)) / 60 * (0.28 * P / (T + 273))   // Skyfield's refraction()
    const k = (34 / 60) / bennett(0, 10, 1010)
    expect(k).toBeCloseTo(0.98685, 5)
    fc.assert(fc.property(fc.double({ min: REFRACTION_FLOOR, max: 89.9, noNaN: true }), fc.double({ min: -30, max: 40, noNaN: true }), fc.double({ min: 500, max: 1080, noNaN: true }), (a, T, P) => {
      expect(refraction(a, T, P)).toBeCloseTo(k * bennett(a, T, P), 12)
    }), { numRuns: 500 })
    expect(refraction(89.95, 10, 1010)).toBe(0); expect(refraction(REFRACTION_FLOOR - 0.01, 10, 1010)).toBe(0)
    // the customer's case: −1.02° true from 320 m above the sea: about 40′ of refraction, not 0
    const a = apparentAltitudeOf(-1.02, 10, 1010, -seaDip(320))!
    expect((a + 1.02) * 60).toBeGreaterThan(38); expect((a + 1.02) * 60).toBeLessThan(42)
    // alignment's solver uses the same model, falling back to no refraction only below the floor
    expect(refract(5, 10, 1010)).toBe(apparentAltitudeOf(5, 10, 1010, -90)); expect(refract(-5, 10, 1010)).toBe(-5)
  })
  it("asking two endpoints the same question gives the same answer: /v1/crossing at apparent 0°, upper limb = /v1/day's rise and set (≤ 1 ms)", () => {
    for (const [lat, lon, tz, date, extra] of [[40.7484, -73.9857, "America/New_York", "2026-10-29", {}], [69.6492, 18.9553, "Europe/Oslo", "2026-10-29", {}],
      [-33.8568, 151.2153, "Australia/Sydney", "2026-10-29", { temperature: -20, pressure: 1040 }], [40.7484, -73.9857, "America/New_York", "2026-10-28", { height: 320, heightRef: "msl" as const }]] as const) {
      const d = dayRequest(diskBlocks, { date, tz, lat, lon, ...extra }); if (!("ok" in d)) throw new Error(d.error)
      const H = d.ok.conventions.riseSet.horizon.altitude!
      const w = { startMs: Date.parse(d.ok.start), endMs: Date.parse(d.ok.end) }
      const c = crossingRequest(diskBlocks, { ...w, lat, lon, ...extra, body: "sun", altitude: H, altitudeType: "apparent", limb: "upper" }); if (!("ok" in c)) throw new Error(c.error)
      const sun = d.ok.events.filter(e => e.body === "sun" && (e.kind === "rise" || e.kind === "set"))
      expect(c.ok.crossings.map(x => x.direction)).toEqual(sun.map(e => e.kind))
      c.ok.crossings.forEach((x, i) => expect(Math.abs(Date.parse(x.time) - Date.parse(sun[i]!.time)), `${lat} ${date} ${x.direction}`).toBeLessThanOrEqual(1))
      expect(c.ok.conventions.refraction!.model).toBe(d.ok.conventions.riseSet.refraction.model)
    }
  })
  it("is monotone and continuous in true altitude, null exactly below max(horizon, floor), and a − R(a) = h holds", () => {
    fc.assert(fc.property(fc.double({ min: -3, max: 5, noNaN: true }), fc.double({ min: -1.6, max: 0, noNaN: true }), (h, H) => {
      const a = apparentAltitudeOf(h, 10, 1010, H), floor = Math.max(H, REFRACTION_FLOOR)
      if (a === null) expect(h).toBeLessThan(floor - refraction(floor, 10, 1010) + 1e-9)
      else { expect(a).toBeGreaterThanOrEqual(floor - 1e-12); expect(Math.abs(a - refraction(a, 10, 1010) - h)).toBeLessThan(1e-8)
        const b = apparentAltitudeOf(h + 1e-4, 10, 1010, H)!; expect(b).toBeGreaterThan(a); expect(b - a).toBeLessThan(2e-4) }
    }), { numRuns: 500 })
  })
  it("refraction is exactly the almanac 34′ at 0° with the defaults, grows below 0°, and scales with P/T", () => {
    expect(refraction(0, 10, 1010)).toBe(34 / 60)
    expect(refraction(-0.5, 10, 1010)).toBeGreaterThan(34 / 60)
    expect(refraction(0, -20, 1040) / refraction(0, 10, 1010)).toBeCloseTo((1040 / 1010) * (283 / 253), 12)
  })
})

describe("rates and observer heights", () => {
  it("altitudeRate and azimuthRate match finite differences of the positions themselves (±2 s)", () => {
    fc.assert(fc.property(arbMs, arbGeo, (ms, geo) => {
      const q = { lat: geo.lat, lon: geo.lon, height: geo.height }
      const r = positionRequest(diskBlocks, { ...q, utcMs: ms }), a = positionRequest(diskBlocks, { ...q, utcMs: ms - 2_000 }), b = positionRequest(diskBlocks, { ...q, utcMs: ms + 2_000 })
      for (const k of ["sun", "moon"] as const) {
        // °/min; the steps differ by (10² − 2²)·f‴/6. Altitude has a cusp at the zenith (not differentiable), so within 1° of it only a loose bound holds.
        if (r[k].altitude < 89) expect(Math.abs(r[k].altitudeRate - (b[k].altitude - a[k].altitude) * 15)).toBeLessThan(r[k].altitude < 80 ? 1e-5 : 1e-3)
        if (r[k].altitude < 80) expect(Math.abs(r[k].azimuthRate - (((b[k].azimuth - a[k].azimuth) % 360 + 540) % 360 - 180) * 15)).toBeLessThan(1e-4 / Math.cos(r[k].altitude * Math.PI / 180) ** 2)
      }
    }), { numRuns: 300 })
  })
  it("heightRef=msl and the same ellipsoidal height give the same sky; no height = on the geoid = msl 0", () => {
    const t = Date.parse("2026-10-28T11:51:00Z"), e = positionRequest(diskBlocks, { utcMs: t, lat: 40.7, lon: -74, height: 300 })
    const m = positionRequest(diskBlocks, { utcMs: t, lat: 40.7, lon: -74, height: e.observer.heightMsl, heightRef: "msl" })
    expect(m.sun.altitude).toBeCloseTo(e.sun.altitude, 12); expect(m.observer.heightEllipsoid).toBeCloseTo(300, 9)
    const none = dayRequest(diskBlocks, { date: "2026-10-28", tz: "America/New_York", lat: 40.7, lon: -74 }), msl0 = dayRequest(diskBlocks, { date: "2026-10-28", tz: "America/New_York", lat: 40.7, lon: -74, height: 0, heightRef: "msl" })
    expect("ok" in none && "ok" in msl0 && none.ok.events).toEqual("ok" in msl0 && msl0.ok.events)
  })
  it("higher eyes see an earlier sunrise and a later sunset; horizon=geometric matches height 0; a high sea horizon below the floor is an error", () => {
    const ev = (o: object) => { const r = dayRequest(diskBlocks, { date: "2026-10-28", tz: "America/New_York", lat: 40.7484, lon: -73.9857, heightRef: "msl", ...o }); if (!("ok" in r)) throw new Error(r.error); return r.ok }
    const t = (r: ReturnType<typeof ev>, k: string) => Date.parse(r.events.find(e => e.body === "sun" && e.kind === k)!.time)
    const z = ev({ height: 0 }), hi = ev({ height: 320 }), g = ev({ height: 320, horizon: "geometric" })
    expect(t(z, "rise") - t(hi, "rise")).toBeGreaterThan(150_000); expect(t(hi, "set") - t(z, "set")).toBeGreaterThan(150_000)   // ≈ 3 min at 320 m
    expect(Math.abs(t(g, "rise") - t(z, "rise"))).toBeLessThan(50)   // only the 320 m of parallax-free height differs
    expect(Math.abs(t(hi, "civilDawn") - t(z, "civilDawn"))).toBeLessThan(50)   // twilight does not use the horizon (parallax only)
    const lo = ev({ height: 320, limb: "lower" }), c = ev({ height: 320, limb: "center" })
    expect(t(hi, "rise")).toBeLessThan(t(c, "rise")); expect(t(c, "rise")).toBeLessThan(t(lo, "rise"))
    expect(dayRequest(diskBlocks, { date: "2026-10-28", tz: "America/New_York", lat: 40.7, lon: -74, height: 5000, heightRef: "msl" })).toHaveProperty("error")
  })
})

describe("horizon profiles", () => {
  it("parse az:el, sort, reject junk; interpolate linearly with wraparound through north", () => {
    const p = parseProfile("350:2, 10:4,180:0")
    if (typeof p === "string") throw new Error(p)
    expect(profileAt(p, 0)).toBeCloseTo(3, 12); expect(profileAt(p, 350)).toBe(2); expect(profileAt(p, 95)).toBeCloseTo(2, 12); expect(profileAt(p, 265)).toBeCloseTo(1, 12)
    for (const bad of ["", "1:2:3", "400:1", "10:95", "10:1,10:2", "10:-3", Array.from({ length: 361 }, (_, i) => `${i % 360}.5:1`).join(",")]) expect(typeof parseProfile(bad)).toBe("string")
    const flat = parseProfile("0:0.4"); if (typeof flat === "string") throw new Error(flat)
    expect(profileAt(flat, 123)).toBe(0.4)
  })
  it("a flat profile equals the same numeric horizon", () => {
    const a = dayRequest(diskBlocks, { date: "2026-10-28", tz: "America/New_York", lat: 40.7, lon: -74, horizon: 0.4 }), b = dayRequest(diskBlocks, { date: "2026-10-28", tz: "America/New_York", lat: 40.7, lon: -74, horizonProfile: "0:0.4,180:0.4" })
    if (!("ok" in a) || !("ok" in b)) throw new Error("bad")
    a.ok.events.forEach((e, i) => expect(Math.abs(Date.parse(e.time) - Date.parse(b.ok.events[i]!.time))).toBeLessThanOrEqual(1))
  })
})

describe("time", () => {
  it("leap seconds are the IERS table", () => {
    expect(taiMinusUtc(Date.parse("1972-01-01T00:00:00Z"))).toBe(10)
    expect(taiMinusUtc(Date.parse("2016-12-31T23:59:59Z"))).toBe(36); expect(taiMinusUtc(Date.parse("2017-01-01T00:00:00Z"))).toBe(37)
    const t = instant(Date.parse("2026-10-28T11:51:00Z"), 0.0881733)
    expect(t.deltaT).toBeCloseTo(69.184 - 0.0881733, 9)
  })
})

describe("root finding", () => {
  it("finds both roots of a grazing parabola and none for a non-touching one", () => {
    const t0 = 0, t1 = 3_600_000, step = 300_000
    const touch = crossings(ms => -1 + 2 * Math.exp(-(((ms - 1_777_000) / 200_000) ** 2)), t0, t1, step)   // peaks at +1 for ~0.28 of a sample
    expect(touch.map(c => c.rising)).toEqual([true, false])
    expect(crossings(ms => -1 + 0.9 * Math.exp(-(((ms - 1_777_000) / 200_000) ** 2)), t0, t1, step)).toEqual([])
    const lin = crossings(ms => ms - 1_234_567.891, t0, t1, step)
    expect(lin.length).toBe(1); expect(Math.abs(lin[0]!.ms - 1_234_567.891)).toBeLessThan(0.1)
  })
})

describe("day invariants", () => {
  it("events sorted, bodies alternate rise/set, twilight order", () => {
    const sample = JSON.parse(readFileSync(`${__dirname}/fixtures/oracle.json`, "utf8")).day.slice(0, 12)
    for (const c of sample) {
      const r = day(diskBlocks, { date: c.query.date, tz: c.query.tz, geo: { lat: +c.query.lat, lon: +c.query.lon, height: +(c.query.height ?? 0) } })
      const ts = r.events.map(e => Date.parse(e.time)); expect(ts.toSorted((a, b) => a - b)).toEqual(ts)
      for (const body of ["sun", "moon"] as const) {
        const rs = r.events.filter(e => e.body === body && (e.kind === "rise" || e.kind === "set"))
        for (let i = 1; i < rs.length; i++) expect(rs[i]!.kind).not.toBe(rs[i - 1]!.kind)
      }
      const k = (kind: string) => r.events.find(e => e.kind === kind)
      if (k("astronomicalDawn") && k("nauticalDawn") && k("civilDawn") && k("rise") && k("civilDawn")!.body === "sun")
        expect(Date.parse(k("astronomicalDawn")!.time) < Date.parse(k("nauticalDawn")!.time) && Date.parse(k("nauticalDawn")!.time) < Date.parse(k("civilDawn")!.time)).toBe(true)
    }
  })
})

describe("alignment self-consistency", () => {
  it("standing at a track point, the body sits exactly on the target's apparent direction", () => {
    const target = { lat: 40.68925, lon: -74.0445, height: 63.4 }, observerHeight = -30.9
    const r = alignment(diskBlocks, { body: "moon", target, observerHeight, startMs: Date.parse("2026-10-28T23:45:00Z"), endMs: Date.parse("2026-10-29T02:00:00Z"), stepSeconds: 900, maxDistanceKm: 20 })
    expect(r.track.length).toBeGreaterThan(5)
    for (const p of r.track) {
      const P = { lat: p.lat, lon: p.lon, height: observerHeight }
      const f = frameAt(diskBlocks, instant(Date.parse(p.time)), P), a = apparent(diskBlocks, f, "moon"), tp = topocentric(f, a.v)
      const e = targetElevation(P, target)
      expect(Math.abs(((tp.azimuth - e.azimuth + 540) % 360) - 180)).toBeLessThan(1e-7)       // (1)
      expect(Math.abs(refract(tp.altitude, 10, 1010) - e.elevation)).toBeLessThan(1e-7)        // (2)
      expect(p.iterations).toBeLessThanOrEqual(12)
    }
  })
})
