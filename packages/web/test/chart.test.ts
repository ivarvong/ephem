// The sky chart's geometry and label layout (pure: lib/chart.ts, lib/labels.ts), and pointing (lib/pose.ts). The chart over
// every sky state, from the API's own answers, is packages/worker/test/home.test.ts.
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { GLOW, altU, chartCenter, chartGeom, chX, skyModel, trackEvents, unwrapAz, wrapXs } from "../src/lib/chart.ts"
import { layoutLabels, overlapArea, segHitsRect, isPlaced, type Rect, type Seg } from "../src/lib/labels.ts"
import { aimShort, aimText, poseFrom } from "../src/lib/pose.ts"

describe("chart geometry", () => {
  it("altitude scale: linear above the horizon, a smooth (C2) compression below; monotonic; the slope continuous everywhere", () => {
    expect(altU(90)).toBe(90)
    expect(altU(0)).toBe(0)
    expect(altU(30)).toBe(30)
    expect(altU(-18)).toBeCloseTo(-16.64, 2)
    expect(altU(-90)).toBeCloseTo(-35.52, 2)
    const d = (a: number, h = 1e-4) => (altU(a + h) - altU(a - h)) / (2 * h)
    for (let a = -89.5; a < 89.5; a += 0.25) {
      expect(altU(a + 0.25)).toBeGreaterThan(altU(a))
      expect(Math.abs(d(a + 0.25) - d(a)), `slope jump at ${a}`).toBeLessThan(0.01)
    }
    expect(d(1e-3)).toBeCloseTo(1, 4)
    expect(d(-1e-3)).toBeCloseTo(1, 4)
  })
  it("unwrapped azimuths never jump", () => {
    expect(unwrapAz([350, 355, 2, 9, 359, 340])).toEqual([350, 355, 362, 369, 359, 340])
  })
  it("centre: midway between the bodies on the shorter arc, so the seam falls where neither is", () => {
    expect(chartCenter(40, [120, 250])).toBe(185)
    expect(chartCenter(-33, [350, 30])).toBe(10)
    for (const [a, b] of [
      [5, 250],
      [274, 49],
      [0, 180],
      [359, 1],
    ] as const) {
      const c = chartCenter(40, [a, b]),
        seam = (c + 180) % 360
      for (const x of [a, b]) expect(Math.abs(((((x - seam) % 360) + 540) % 360) - 180)).toBeGreaterThanOrEqual(89)
    }
  })
  it("events from a synthetic day: rise, transit, set, anti-transit at the right times and azimuths", () => {
    const s = [],
      T = 864e5
    for (let i = 0; i <= 72; i++) {
      const t = i * 20 * 60e3
      s.push({ t, alt: 40 * Math.sin((2 * Math.PI * t) / T) - 10, az: (90 + (360 * t) / T) % 360 })
    }
    const ev = trackEvents(s, 0)
    expect(ev.map((e) => e.kind)).toEqual(["rise", "transit", "set", "antitransit"])
    expect(Math.abs(ev[0]!.t - (Math.asin(10 / 40) / (2 * Math.PI)) * T)).toBeLessThan(60e3)
    expect(Math.abs(ev[1]!.t - T / 4)).toBeLessThan(60e3)
    expect(Math.abs(ev[1]!.alt - 30)).toBeLessThan(0.05)
    expect(Math.abs(ev[3]!.alt + 50)).toBeLessThan(0.05)
    expect(Math.abs(ev[1]!.az - 180)).toBeLessThan(0.5)
  })
  it("a track that never crosses the horizon has culminations and no rise or set (polar day and night)", () => {
    const s = []
    for (let i = 0; i <= 72; i++) s.push({ t: i * 12e5, alt: 20 * Math.cos((2 * Math.PI * i) / 72) - 30, az: i * 5 })
    expect(trackEvents(s, -0.833).map((e) => e.kind)).toEqual(["antitransit"])
  })
})

describe("the azimuth wrap", () => {
  it("a body within its glow of an edge is drawn at the opposite edge too (the Moon at the seam, centre 180°)", () => {
    const W = 390,
      H = 354,
      g = chartGeom(W, H),
      r = 6
    const body = (az: number) => ({
      key: "moon" as const,
      name: "Moon",
      az,
      alt: 20,
      r,
      pts: [],
      nowIdx: 0,
      period: 89428e3,
    })
    const model = (az: number) =>
      skyModel({
        W,
        H,
        insetL: 0,
        insetR: 0,
        center: 180,
        now: 0,
        ctl: null,
        pose: null,
        meas: (t) => t.length * 7,
        lh: 17,
        bodies: [body(az)],
      })
    for (const az of [1, 359, 0.2, 359.8, 3, 357]) {
      // the seam is at 0°: x within r·glow of 0 or W
      const d = model(az).discs[0]!
      expect(d.xs.length, `az ${az}`).toBe(2)
      expect(d.xs[0]).toBe(chX(az, g, 180))
      expect(Math.abs(d.xs[1]! - d.xs[0]!)).toBeCloseTo(W, 9)
      expect(Math.min(...d.xs)).toBeLessThan(r * GLOW.moon)
      expect(Math.max(...d.xs)).toBeGreaterThan(W - r * GLOW.moon)
      expect(model(az).hard.filter((h) => h.id?.startsWith("moon-disc"))).toHaveLength(2) // labels keep clear of both copies
    }
    for (const az of [41, 180, 300, 20, 340]) expect(model(az).discs[0]!.xs, `az ${az}`).toHaveLength(1) // farther in: one disc
    expect(wrapXs(10, 19.2, W)).toEqual([10, 400])
    expect(wrapXs(380, 19.2, W)).toEqual([380, -10])
    expect(wrapXs(195, 19.2, W)).toEqual([195])
  })
})

describe("labels", () => {
  it("segment/rect intersection", () => {
    const r = { x: 10, y: 10, w: 10, h: 10 }
    expect(segHitsRect([0, 0, 30, 30], r)).toBe(true)
    expect(segHitsRect([12, 12, 14, 14], r)).toBe(true)
    expect(segHitsRect([0, 25, 30, 25], r)).toBe(false)
    expect(segHitsRect([0, 0, 9, 30], r)).toBe(false)
    expect(segHitsRect([15, 0, 15, 5], r)).toBe(false)
  })
  it("any two bodies, any tracks: every name is placed, in bounds, clear of the hard rects and of each other; uncrossed when it says so", () => {
    const W = 390,
      H = 354,
      bounds = { x0: 4, y0: 2, x1: W - 4, y1: H - 21 }
    const pt = fc.record({ x: fc.integer({ min: 0, max: W }), y: fc.integer({ min: 0, max: H - 20 }) })
    const seg = fc
      .tuple(
        fc.integer({ min: -20, max: W + 20 }),
        fc.integer({ min: 0, max: H }),
        fc.integer({ min: -60, max: 60 }),
        fc.integer({ min: -60, max: 60 }),
      )
      .map(([x, y, dx, dy]): Seg => [x, y, x + dx, y + dy])
    fc.assert(
      fc.property(pt, pt, fc.array(seg, { maxLength: 40 }), (s, m, segs) => {
        const disc = (id: string, p: { x: number; y: number }, r: number): Rect => ({
          id,
          x: p.x - r - 4,
          y: p.y - r - 4,
          w: 2 * r + 8,
          h: 2 * r + 8,
        })
        const hard = [
          { id: "ctl", x: W - 44, y: 0, w: 44, h: 44 },
          { id: "horizon", x: -1e4, y: 200, w: 2e4, h: 2 },
          disc("sun-disc", s, 5),
          disc("moon-disc", m, 6),
        ]
        const items = [
          { id: "Sun", w: 40, h: 17, x: s.x, y: s.y, r: 7, prio: 0, body: true },
          { id: "Moon", w: 50, h: 17, x: m.x, y: m.y, r: 8, prio: 0, body: true },
        ]
        const out = layoutLabels(items, hard, segs, bounds, 3),
          shown = out.filter(isPlaced)
        expect(shown.map((p) => p.id).sort()).toEqual(["Moon", "Sun"]) // a body is always named
        for (const a of shown) {
          expect(a.x).toBeGreaterThanOrEqual(bounds.x0)
          expect(a.x + a.w).toBeLessThanOrEqual(bounds.x1)
          expect(a.y).toBeGreaterThanOrEqual(bounds.y0)
          expect(a.y + a.h).toBeLessThanOrEqual(bounds.y1)
          if (!a.crossed) expect(segs.some((sg) => segHitsRect(sg, a))).toBe(false)
          for (const b of shown) if (b !== a) expect(overlapArea(a, b)).toBe(0)
        }
      }),
      { numRuns: 300, seed: 20261031 },
    )
  })
})

describe("pointing", () => {
  it("iOS compass heading + declination; Android absolute alpha from the rotation; tilt from beta", () => {
    const ios = poseFrom({ alpha: 0, beta: 90, gamma: 0, webkitCompassHeading: 10 }, -13)!
    expect(ios.az).toBeCloseTo(357, 9)
    expect(ios.alt).toBeCloseTo(0, 9)
    const up = poseFrom({ alpha: 90, beta: 135, gamma: 0, absolute: true }, 0)!
    expect(up.az).toBeCloseTo(270, 6)
    expect(up.alt).toBeCloseTo(45, 6)
    expect(poseFrom({ alpha: 30, beta: 90, gamma: 0 }, 0)).toBeNull()
    expect(aimText("Moon", { az: 20, alt: -23.4 }, { az: 60, alt: 18 })).toBe(
      "Moon, 23.4° below the horizon: turn 40° left, tilt 41° down",
    )
    expect(aimText("Sun", { az: 181, alt: 30 }, { az: 180, alt: 29 })).toBe("Sun: dead ahead")
    expect(aimShort("Sun", { az: 20, alt: -23.4 }, { az: 177, alt: 18 })).toBe("Sun ← 157° ↓41°")
    expect(aimShort("Moon", { az: 181, alt: 30 }, { az: 180, alt: 29 })).toBe("Moon on target")
  })
})
