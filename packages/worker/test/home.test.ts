import { describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import fc from "fast-check"
import { makeHandler } from "../src/app.ts"
import { CORE_JS, initialQueries, page, visitor } from "../src/home.ts"
import { REC, direct, makeBlocks } from "../src/blocks.ts"

const NYC = { latitude: "40.71427", longitude: "-74.00597", city: "New York City", region: "New York", country: "US", timezone: "America/New_York", colo: "EWR" }
const u = (q = "") => new URL("https://ephem.example/" + q)
const V = { lat: 1, lon: 2, place: "x", city: "x", tz: "UTC", colo: null, source: "query" } as const

describe("home: who is the sky for", () => {
  it("uses Cloudflare's geolocation, titled by the city alone", () => {
    expect(visitor(u(), NYC)).toEqual({ lat: 40.71427, lon: -74.00597, place: "New York City, New York, US", city: "New York City", tz: "America/New_York", colo: "EWR", source: "cloudflare" })
  })
  it("?lat&lon override cf, keep cf's zone unless ?tz is given, and reject nonsense", () => {
    expect(visitor(u("?lat=69.65&lon=18.96&tz=Europe/Oslo&place=Troms%C3%B8"), NYC)).toMatchObject({ lat: 69.65, lon: 18.96, tz: "Europe/Oslo", place: "Tromsø", city: "Tromsø", source: "query" })
    expect(visitor(u("?lat=1&lon=2"), NYC)).toMatchObject({ tz: "America/New_York", source: "query", city: "1.00° N, 2.00° E" })
    expect(visitor(u("?lat=91&lon=2"), NYC).source).toBe("cloudflare")
    expect(visitor(u("?lat=1&lon=2&tz=Mars/Olympus"), NYC).tz).toBe("America/New_York")
  })
  it("falls back to Liberty Island without cf, and to UTC for an unknown cf zone", () => {
    expect(visitor(u(), undefined)).toMatchObject({ lat: 40.6892, lon: -74.0445, city: "Liberty Island", source: "default", colo: null })
    expect(visitor(u(), { ...NYC, timezone: "Nowhere/Land" }).tz).toBe("UTC")
  })
  it("embeds the visitor safely: no script breakout from place names", () => {
    const html = page({ ...V, place: "</script><script>alert(1)</script>", city: "</script><script>alert(1)</script>" })
    expect(html).not.toContain("</script><script>alert(1)")
    expect(html).toContain("\\u003c/script>")
  })
  it("the client script parses (it lives in a template literal: a stray \\n or ${ breaks it silently)", () => {
    const html = page(V)
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]!)
    expect(scripts.length).toBe(2)
    for (const js of scripts) expect(() => new Function(js)).not.toThrow()
    expect(html).toContain('id="wx"'); expect(html).toContain("/v1/weather"); expect(html).toContain("/v1/magnetic")
  })
  it("keeps precision behind one collapsed Under the hood section", () => {
    const html = page(V)
    expect(html).toMatch(/<details class="disc hood" id="hood">\s*<summary>Under the hood<\/summary>/)
    expect(html).toContain('id="curl"'); expect(html).toContain('id="diag"')
    expect(html).not.toMatch(/details class="hood"[^>]* open/)
  })
  it("GET / serves the page through the Effect router, located from request.cf", async () => {
    const handler = makeHandler(makeBlocks(async () => { throw new Error("no blocks needed") }))
    const req = new Request("https://ephem.example/")
    Object.defineProperty(req, "cf", { value: NYC })
    const res = await handler(req)
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    expect(res.headers.get("cache-control")).toBe("private, no-store")
    const body = await res.text()
    expect(body).toContain('"place":"New York City, New York, US"')
    expect(body).toContain("<title>ephem · the sky over New York City</title>")
  })
})

interface Rect { id?: string; x: number; y: number; w: number; h: number; clear?: boolean }
interface Core {
  countdown(ms: number): string; lede(sun: object, moon: object): string; condition(st: object): string
  windText(w: object, decl: number | null): string
  altOf(b: object): number; skyY(b: object, hy: number, k: number): number; isSet(b: object, k: number, r: number): boolean
  placeLabels(items: object[], obstacles: Rect[], bounds: { x0: number; y0: number; x1: number; y1: number }, soft?: Rect[]): Rect[]
  overlapArea(a: Rect, b: Rect): number
  segHitsRect(s: number[], r: Rect): boolean
  ringLabelSpot(y: number, w: number, h: number, bounds: { x0: number; y0: number; x1: number; y1: number }, segs: number[][], obstacles: Rect[], pad?: number): Rect | null
}
const core = new Function(CORE_JS + "; return { countdown, lede, condition, windText, placeLabels, overlapArea, altOf, skyY, isSet, segHitsRect, ringLabelSpot }")() as Core

const moon = (alt: number, az: number) => ({ apparentAltitude: alt, azimuth: az, phase: { name: "waning gibbous", illuminatedFraction: 0.85 } })
describe("home: apparentAltitude null below the horizon (API 2026-10-29)", () => {
  const hy = 470, k = 4, r = 10
  it("a body with apparentAltitude null is placed by its true altitude, below the horizon line, and counts as set", () => {
    const low = { apparentAltitude: null, altitude: -20.31, azimuth: 300 }
    expect(core.altOf(low)).toBe(-20.31)
    expect(core.skyY(low, hy, k)).toBeGreaterThan(hy)          // below the horizon, not sitting on it (null → 0 would put it at hy)
    expect(core.isSet(low, k, r)).toBe(true)                    // so the disc is not drawn
    const grazing = { apparentAltitude: null, altitude: -0.4, azimuth: 250 }
    expect(core.skyY(grazing, hy, k)).toBeGreaterThan(hy); expect(core.isSet(grazing, k, r)).toBe(false)   // half a disc peeks: drawn, clipped by the ground
    expect(core.altOf({ apparentAltitude: 2.31, altitude: 2.0, azimuth: 100 })).toBe(2.31)
  })
  it("the sentence says the Moon is down when its apparentAltitude is null", () => {
    expect(core.lede({ apparentAltitude: 30, altitude: 29.97, azimuth: 180 }, { ...moon(0, 300), apparentAltitude: null, altitude: -12 })).toBe("The Sun is in the south and the Moon is down.")
  })
  it("the readout says below horizon instead of showing a number, and the client script reads apparentAltitude only through altOf or a null check", () => {
    const html = page(V)
    expect(html).toContain('"below horizon"')
    const uses = html.match(/[a-z]\.apparentAltitude\b(?! == null)/g) ?? []
    expect(uses.length).toBeLessThanOrEqual(4)   // altOf itself, the null-checked readout value, the null-checked aria value, the /v1/track sample copy (null kept)
    expect(html).toMatch(/apparentAltitude: x\.apparentAltitude\[i\]/)
  })
})

describe("home: words", () => {
  it("countdowns carry seconds only under a minute", () => {
    expect(core.countdown(35e3)).toBe("in 35 s")
    expect(core.countdown(14 * 60e3)).toBe("in 14 min")
    expect(core.countdown((3 * 3600 + 59 * 60 + 25) * 1e3)).toBe("in 3 h 59 min")
    expect(core.countdown(2 * 3600e3)).toBe("in 2 h")
  })
  it("one sentence for what's up", () => {
    expect(core.lede({ apparentAltitude: 2.83, azimuth: 110.37 }, moon(39.58, 274.31))).toBe("The Sun is low in the east-southeast, and the waning gibbous Moon is in the west.")
    expect(core.lede({ apparentAltitude: -55, azimuth: 314 }, moon(34.5, 82))).toBe("It's night, and the waning gibbous Moon is in the east.")
    expect(core.lede({ apparentAltitude: 45, azimuth: 180 }, moon(-9, 318))).toBe("The Sun is high in the south and the Moon is down.")
    expect(core.lede({ apparentAltitude: -3, azimuth: 100 }, moon(-1, 300))).toBe("It's dawn and the Moon is down.")
  })
  it("METAR wind in whole degrees, true and magnetic (reported to the nearest 10°)", () => {
    const w = { directionDegTrue: 260, speedKt: 12, gustKt: null, calm: false, variable: false }
    expect(core.windText(w, -12.46)).toBe("Wind 260° T · 272° M at 12 kt")
    expect(core.windText({ ...w, directionDegTrue: 350, gustKt: 25 }, 12.4)).toBe("Wind 350° T · 338° M at 12 kt, gusting 25 kt")
    expect(core.windText({ ...w, directionDegTrue: 355 }, -6)).toBe("Wind 355° T · 1° M at 12 kt")
    expect(core.windText({ ...w, calm: true, speedKt: 0 }, 0)).toBe("Wind calm")
    expect(core.windText({ ...w, variable: true, directionDegTrue: null, speedKt: 3 }, 0)).toBe("Wind variable at 3 kt")
  })
  it("conditions from present weather, else the thickest cloud layer", () => {
    expect(core.condition({ wx: "-RA BR", sky: [] })).toBe("Light rain, mist")
    expect(core.condition({ wx: "+SHRA", sky: [] })).toBe("Heavy rain showers")
    expect(core.condition({ wx: "VCTS", sky: [] })).toBe("Thunderstorm nearby")
    expect(core.condition({ wx: null, sky: [{ cover: "FEW" }, { cover: "BKN" }] })).toBe("Mostly cloudy")
    expect(core.condition({ wx: null, sky: [], raw: "METAR KJRB 291056Z AUTO 26004KT 10SM CLR 13/13 A3030" })).toBe("Clear")
  })
})

// The canvas's label layout, run against the same obstacle set draw() builds: compass names and ticks under the
// horizon, two altitude-ring labels at the left edge, a ground band and the reserved title band (the bounds).
describe("home: sky labels never collide", () => {
  const W = 390, top = 88, hy = 470, k = (hy - top) / 94, r = 10
  const bounds = { x0: 8, y0: top, x1: W - 8, y1: hy - 3 }
  const fixedFor = (center: number) => {
    const out: Rect[] = []
    for (let az = 0; az < 360; az += 15) {
      const x = W / 2 + (((az - center) % 360 + 540) % 360 - 180) * k
      if (x < -20 || x > W + 20) continue
      out.push({ id: "tick" + az, x: x - 1, y: hy, w: 2, h: az % 45 ? 4 : 8 })
      if (az % 45 === 0) out.push({ id: "cmp" + az, x: x - 9, y: hy + 14, w: 18, h: 13 })
    }
    for (const alt of [30, 60]) out.push({ id: "alt" + alt, x: 14, y: hy - alt * k - 16, w: 26, h: 13 })
    out.push({ id: "ground", x: -1e4, y: hy - 2, w: 2e4, h: 1e4 })
    return out
  }
  const disc = (id: string, x: number, y: number): Rect => ({ id, x: x - r, y: y - r, w: 2 * r, h: Math.min(hy, y + r) - (y - r) })
  const check = (placed: Rect[], obstacles: Rect[]) => {
    for (const p of placed) {
      expect(p.clear).toBe(true)
      expect(p.y).toBeGreaterThanOrEqual(top)
      expect(p.y + p.h).toBeLessThanOrEqual(hy - 3)
      for (const o of obstacles) expect(core.overlapArea(p, o), p.id + " vs " + o.id).toBe(0)
    }
    for (let i = 0; i < placed.length; i++) for (let j = i + 1; j < placed.length; j++) expect(core.overlapArea(placed[i]!, placed[j]!)).toBe(0)
  }

  it("the Sun 3° up at dawn, between compass ticks, with the Moon off-screen behind a ring label", () => {
    const sun = { x: W / 2, y: hy - 3 * k } // centred on the Sun, as the page does at dawn
    const obstacles = [...fixedFor(110.37), disc("Sun-disc", sun.x, sun.y)]
    const items = [
      { id: "Sun", x: sun.x, y: sun.y, r, w: 28, h: 16 },
      { id: "Moon-edge", x: 12, y: hy - 30 * k, w: 52, h: 16, edge: "left" }, // lands right on the "30°" ring label
    ]
    const placed = core.placeLabels(items, obstacles, bounds)
    check(placed, obstacles)
    expect(placed[0]!.y + placed[0]!.h).toBeLessThanOrEqual(sun.y - r) // above the Sun, not below the horizon
  })
  it("the Sun on the horizon itself (half set): its label stays in the sky", () => {
    const obstacles = [...fixedFor(250), disc("Sun-disc", W / 2, hy)]
    const placed = core.placeLabels([{ id: "Sun", x: W / 2, y: hy, r, w: 28, h: 16 }], obstacles, bounds)
    check(placed, obstacles)
  })
  it("a conjunction: both bodies within a disc of each other, near the zenith under the title band", () => {
    const a = { x: 180, y: top + 4 }, b = { x: 196, y: top + 12 }
    const obstacles = [...fixedFor(180), disc("Sun-disc", a.x, a.y), disc("Moon-disc", b.x, b.y)]
    const placed = core.placeLabels([{ id: "Sun", ...a, r, w: 28, h: 16 }, { id: "Moon", ...b, r, w: 38, h: 16 }], obstacles, bounds)
    check(placed, obstacles)
  })
  it("path lines are avoided when there is room, and never force a label onto text", () => {
    const m = { x: 195, y: 300 }, path: Rect[] = []
    for (let y = 150; y < 460; y += 5) path.push({ id: "path", x: m.x - 1.5, y: y - 1.5, w: 3, h: 3 }) // a vertical line through the Moon
    const obstacles = [...fixedFor(180), disc("Moon-disc", m.x, m.y)]
    const [p] = core.placeLabels([{ id: "Moon", ...m, r, w: 38, h: 16 }], obstacles, bounds, path)
    check([p!], obstacles)
    for (const d of path) expect(core.overlapArea(p!, d)).toBe(0)
  })
  it("any two bodies anywhere in the sky, any heading: every label finds a clear spot", () => {
    const body = fc.record({ az: fc.double({ min: -45, max: 45, noNaN: true }), alt: fc.double({ min: -0.5, max: 92, noNaN: true }) })
    fc.assert(fc.property(fc.double({ min: 0, max: 359.9, noNaN: true }), body, body, fc.boolean(), (center, s, m, moonOff) => {
      const sx = W / 2 + s.az * k, sy = hy - s.alt * k, mx = W / 2 + m.az * k, my = hy - m.alt * k
      const obstacles = [...fixedFor(center), disc("Sun-disc", sx, sy)]
      const items: object[] = [{ id: "Sun", x: sx, y: sy, r, w: 28, h: 16 }]
      if (moonOff) items.push({ id: "Moon-edge", x: W - 12, y: Math.max(top + 16, Math.min(hy - 16, my)), w: 52, h: 16, edge: "right" })
      else { obstacles.push(disc("Moon-disc", mx, my)); items.push({ id: "Moon", x: mx, y: my, r, w: 38, h: 16 }) }
      check(core.placeLabels(items, obstacles, bounds), obstacles)
    }), { numRuns: 400, seed: 20261029 })
  })
})

// Altitude-ring labels used to sit at a fixed spot (x = 14, above the line) and were not part of the layout, so a path could
// run straight through "30°" (Ivar's iPhone, Islip NY, 2026-10-29). Now each takes the first spot along its ring no path touches.
describe("home: altitude-ring labels stay off the path lines", () => {
  const W = 390, top = 88, hy = 470, bounds = { x0: 8, y0: top, x1: W - 8, y1: hy - 3 }, w = 22, h = 13, ring = 364.5
  const grown = (r: Rect, pad = 3): Rect => ({ x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad })
  it("segment/rect intersection", () => {
    const r = { x: 10, y: 10, w: 10, h: 10 }
    expect(core.segHitsRect([0, 0, 30, 30], r)).toBe(true)      // through it
    expect(core.segHitsRect([12, 12, 14, 14], r)).toBe(true)    // inside it
    expect(core.segHitsRect([0, 25, 30, 25], r)).toBe(false)    // passes below
    expect(core.segHitsRect([0, 0, 9, 30], r)).toBe(false)      // passes to the left
    expect(core.segHitsRect([15, 0, 15, 5], r)).toBe(false)     // stops short
  })
  it("the Islip case: the Moon's line crosses the left-edge spot, so the label moves and no segment touches it", () => {
    const moon = [[0, 400, 20, 370], [20, 370, 40, 340], [40, 340, 60, 310]]   // rising through x 14..36 at the 30° ring
    const old = { x: 14, y: ring - h - 3, w, h }
    expect(moon.some(s => core.segHitsRect(s, old))).toBe(true)                // the old fixed spot collided
    const spot = core.ringLabelSpot(ring, w, h, bounds, moon, [])!
    expect(spot).not.toBeNull()
    for (const s of moon) expect(core.segHitsRect(s, grown(spot))).toBe(false)
  })
  it("prefers the left edge when it is clear, and drops the label when the whole ring is crossed", () => {
    expect(core.ringLabelSpot(ring, w, h, bounds, [], [])).toEqual({ x: 14, y: ring - h - 3, w, h })
    const zigzag: number[][] = []
    for (let x = 0; x < W; x += 6) zigzag.push([x, ring - 30, x + 3, ring + 30], [x + 3, ring + 30, x + 6, ring - 30])
    expect(core.ringLabelSpot(ring, w, h, bounds, zigzag, [])).toBeNull()
  })
  it("any set of path lines and discs: a returned spot touches none of them and stays in the sky", () => {
    // integers, not fc.double: double generation leans hard on the range ends, which almost never lands a line on a label
    const seg = fc.tuple(fc.integer({ min: -20, max: W + 20 }), fc.integer({ min: top, max: hy }), fc.integer({ min: -60, max: 60 }), fc.integer({ min: -60, max: 60 }))
      .map(([x, y, dx, dy]) => [x, y, x + dx, y + dy])
    const disc = fc.tuple(fc.integer({ min: 0, max: W }), fc.integer({ min: top, max: hy })).map(([x, y]) => ({ x: x - 20, y: y - 20, w: 40, h: 40 }))
    fc.assert(fc.property(fc.integer({ min: top + 20, max: hy - 20 }), fc.array(seg, { maxLength: 60 }), fc.array(disc, { maxLength: 2 }), (y, segs, discs) => {
      const spot = core.ringLabelSpot(y, w, h, bounds, segs, discs)
      if (!spot) return
      for (const s of segs) expect(core.segHitsRect(s, grown(spot))).toBe(false)
      for (const d of discs) expect(core.overlapArea(grown(spot), d)).toBe(0)
      expect(spot.y).toBeGreaterThanOrEqual(top); expect(spot.y + h).toBeLessThanOrEqual(hy - 3)
      expect(spot.x).toBeGreaterThanOrEqual(bounds.x0); expect(spot.x + w).toBeLessThanOrEqual(bounds.x1)
    }), { numRuns: 400, seed: 20261029 })
  })
  it("first load fetches only what was not embedded: one /v1/track (not a /v1/position per grid point), live position, today, weather", () => {
    const html = page(V), calls = [...html.matchAll(/api\("(\/v1\/[a-z]+)"/g)].map(m => m[1])
    expect(calls.toSorted()).toEqual(["/v1/day", "/v1/day", "/v1/magnetic", "/v1/position", "/v1/track", "/v1/weather"])   // tomorrow's day and magnetic are conditional
    expect(html).not.toMatch(/jobs\.push|time: new Date/)                                  // no per-sample fetch loop, no timed live poll
    expect(html).toMatch(/reloadAll\(\) \{[^\n]*loadTrack\(\), loadPos\(\), loadDay\(\), loadWx\(\)\]/)
  })
  it("the page loads no web fonts or external stylesheets (system stacks only)", () => {
    const html = page(V)
    expect(html).not.toMatch(/<link[^>]+stylesheet/); expect(html).not.toContain("fonts.googleapis")
  })
})

// The sky chart (2026-10-30): all 360° by the whole altitude range, bodies always where they are, tracks through sky and ground.
describe("home: sky chart geometry", () => {
  const chart = new Function(CORE_JS + "; return { altU, U_TOP, U_BOT, unwrapAz, chartCenter, trackEvents, poseFrom, aimText }")() as {
    altU(a: number): number; U_TOP: number; U_BOT: number; unwrapAz(a: number[]): number[]; chartCenter(lat: number, azs: number[]): number
    trackEvents(s: { t: number; alt: number; az: number }[], h0: number): { kind: string; t: number; az: number; alt: number }[]
    poseFrom(e: object, decl: number | null): { az: number; alt: number } | null; aimText(name: string, b: { az: number; alt: number }, pose: { az: number; alt: number }): string
  }
  it("altitude scale: linear above the horizon, a smooth (C2) compression below; monotonic; the slope continuous everywhere", () => {
    expect(chart.altU(90)).toBe(90); expect(chart.altU(0)).toBe(0); expect(chart.altU(30)).toBe(30)
    expect(chart.altU(-18)).toBeCloseTo(-16.64, 2); expect(chart.altU(-90)).toBeCloseTo(-35.52, 2)
    const d = (a: number, h = 1e-4) => (chart.altU(a + h) - chart.altU(a - h)) / (2 * h)
    for (let a = -89.5; a < 89.5; a += 0.25) {
      expect(chart.altU(a + 0.25)).toBeGreaterThan(chart.altU(a))
      expect(Math.abs(d(a + 0.25) - d(a)), `slope jump at ${a}`).toBeLessThan(0.01)   // no kink: the slope changes by < 1 % per 0.25°
    }
    expect(d(1e-3)).toBeCloseTo(1, 4); expect(d(-1e-3)).toBeCloseTo(1, 4)   // the same slope either side of the horizon
  })
  it("unwrapped azimuths never jump", () => {
    const u = chart.unwrapAz([350, 355, 2, 9, 359, 340])
    expect(u).toEqual([350, 355, 362, 369, 359, 340])
  })
  it("centre: midway between the bodies on the shorter arc, so the seam falls where neither is", () => {
    expect(chart.chartCenter(40, [120, 250])).toBe(185)
    expect(chart.chartCenter(-33, [350, 30])).toBe(10)
    for (const [a, b] of [[5, 250], [274, 49], [0, 180], [359, 1]]) {
      const c = chart.chartCenter(40, [a!, b!]), seam = (c + 180) % 360
      for (const x of [a!, b!]) expect(Math.abs((((x - seam) % 360) + 540) % 360 - 180)).toBeGreaterThanOrEqual(89)
    }
  })
  it("events from a synthetic day: rise, transit, set, anti-transit at the right times and azimuths", () => {
    // a body on a sine: alt = 40 sin(2π t/24h) - 10, azimuth sweeping 360° a day
    const s = [], T = 864e5
    for (let i = 0; i <= 72; i++) { const t = i * 20 * 60e3; s.push({ t, alt: 40 * Math.sin(2 * Math.PI * t / T) - 10, az: (90 + 360 * t / T) % 360 }) }
    const ev = chart.trackEvents(s, 0), kinds = ev.map(e => e.kind)
    expect(kinds).toEqual(["rise", "transit", "set", "antitransit"])
    const rise = Math.asin(10 / 40) / (2 * Math.PI) * T
    expect(Math.abs(ev[0]!.t - rise)).toBeLessThan(60e3)
    expect(Math.abs(ev[1]!.t - T / 4)).toBeLessThan(60e3); expect(Math.abs(ev[1]!.alt - 30)).toBeLessThan(0.05)
    expect(Math.abs(ev[3]!.alt + 50)).toBeLessThan(0.05)
    expect(Math.abs(ev[1]!.az - 180)).toBeLessThan(0.5)
  })
  it("a track that never crosses the horizon has culminations and no rise or set (polar day and night)", () => {
    const s = []
    for (let i = 0; i <= 72; i++) s.push({ t: i * 12e5, alt: 20 * Math.cos(2 * Math.PI * i / 72) - 30, az: i * 5 })
    expect(chart.trackEvents(s, -0.833).map(e => e.kind)).toEqual(["antitransit"])
  })
  it("pointing: iOS compass heading + declination; Android absolute alpha from the rotation; tilt from beta", () => {
    const ios = chart.poseFrom({ alpha: 0, beta: 90, gamma: 0, webkitCompassHeading: 10 }, -13)!
    expect(ios.az).toBeCloseTo(357, 9); expect(ios.alt).toBeCloseTo(0, 9)
    const up = chart.poseFrom({ alpha: 90, beta: 135, gamma: 0, absolute: true }, 0)!
    expect(up.az).toBeCloseTo(270, 6); expect(up.alt).toBeCloseTo(45, 6)
    expect(chart.poseFrom({ alpha: 30, beta: 90, gamma: 0 }, 0)).toBeNull()   // relative alpha, no compass: nothing to show
    expect(chart.aimText("Moon", { az: 20, alt: -23.4 }, { az: 60, alt: 18 })).toBe("Moon, 23.4° below the horizon: turn 40° left, tilt 41° down")
    expect(chart.aimText("Sun", { az: 181, alt: 30 }, { az: 180, alt: 29 })).toBe("Sun: dead ahead")
  })
})

// One round trip (2026-10-31): the page streams its first-load answers, computed in-process through the router.
describe("home: first-load answers embedded in the streamed page", () => {
  const FIX = resolve(__dirname, "../../core/test/fixtures/blocks")
  const fixtures = makeBlocks(direct(async (first, count) => {
    const out = new Uint8Array(count * REC)
    for (let i = 0; i < count; i++) out.set(readFileSync(`${FIX}/${first + i}.bin`), i * REC)
    return out.buffer
  }))
  const embedded = (html: string, id: string) => {
    const m = new RegExp(`<script type="application/json" id="${id}">(.*?)</script>`).exec(html)
    return m ? JSON.parse(m[1]!) : null
  }
  const strip = (x: { provenance?: unknown }) => ({ ...x, provenance: undefined })   // diagnostics carry timings
  it("embeds /v1/position, /v1/track and /v1/day verbatim: the API's own answers to the page's own queries", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-31T00:13:00Z"))
    try {
      const handler = makeHandler(fixtures)
      const req = new Request("https://ephem.example/"); Object.defineProperty(req, "cf", { value: NYC })
      const res = await handler(req), html = await res.text()
      expect(res.headers.get("cache-control")).toBe("private, no-store")
      expect(html.indexOf("</style>")).toBeLessThan(html.indexOf('id="ephem-position"'))   // the head first, the data after
      expect(html.endsWith("</body></html>")).toBe(true)
      const v = visitor(u(), NYC), Q = initialQueries(v, Date.now())
      const pos = embedded(html, "ephem-position")
      expect(pos.time.utc).toBe("2026-10-31T00:13:00.000Z")
      const timed = await (await handler(new Request(`https://ephem.example${Q["ephem-position"][0]}?${new URLSearchParams({ ...Q["ephem-position"][1], time: pos.time.utc })}`))).json()
      expect(pos.sun).toEqual(timed.sun); expect(pos.moon).toEqual(timed.moon)   // the same instant asked with time=: the same sky
      expect(pos.sun.altitude).toBeCloseTo(-26.6, 0)
      for (const id of ["ephem-track", "ephem-day"] as const) {
        const [path, query] = Q[id], api = await (await handler(new Request(`https://ephem.example${path}?${new URLSearchParams(query)}`))).json()
        expect(strip(embedded(html, id))).toEqual(strip(api))
      }
      expect(embedded(html, "ephem-day").date).toBe("2026-10-30")   // today in New York, not in UTC
    } finally { vi.useRealTimers() }
  })
  it("an answer that fails is left out (the page fetches it); the page still completes", async () => {
    const handler = makeHandler(makeBlocks(async () => { throw new Error("R2 down") }))
    const req = new Request("https://ephem.example/"); Object.defineProperty(req, "cf", { value: NYC })
    const html = await (await handler(req)).text()
    expect(embedded(html, "ephem-position")).toBeNull()
    expect(html.endsWith("</body></html>")).toBe(true)
    expect(html).toContain('__embed("ephem-position")')   // the boot reads it, and fetches without it
  })
})

// The sky chart (2026-10-31, Ivar: "These fucking gaps", "busy as fuck"): one label per body (its name), laid out clear of every
// track, disc and button; each body's track one connected polyline spanning one revolution, both ends on the frame's edges.
// Run on the page's own model over every sky state, from the API's own answers (fixture DE440 blocks), at both phone sizes.
describe("home: the chart in every sky state", () => {
  const FIX = resolve(__dirname, "../../core/test/fixtures/blocks")
  const handler = makeHandler(makeBlocks(direct(async (first, count) => {
    const out = new Uint8Array(count * REC)
    for (let i = 0; i < count; i++) out.set(readFileSync(`${FIX}/${first + i}.bin`), i * REC)
    return out.buffer
  })))
  const ch = new Function(CORE_JS + "; return { skyModel, layoutLabels, chartCenter, overlapArea, segHitsRect, altOf, chartAlt, timelineLayout }")() as {
    skyModel(st: object): { lines: Record<string, { xs: number[]; ys: number[]; split: number }>; items: object[]; hard: Rect[]; segs: number[][]; bounds: { x0: number; y0: number; x1: number; y1: number }; g: { W: number; top: number; ky: number } }
    layoutLabels(items: object[], hard: Rect[], segs: number[][], b: object, pad: number): Array<Rect & { dropped?: boolean; crossed?: boolean }>
    chartCenter(lat: number, azs: number[]): number; overlapArea(a: Rect, b: Rect): number; segHitsRect(s: number[], r: Rect): boolean; altOf(b: object): number; chartAlt(h: number): number
    timelineLayout(evs: object[], sun: object[], s0: number, span: number, w: number, now: number, next: object | null, name: (e: { kind: string }) => string, time: (t: number) => string, meas: (t: string, k: string) => number): { mid: number; labels: Rect[]; leaders: number[][]; nodes: object[] }
  }
  const STATES: Array<[string, number, number, string]> = [
    ["nyc day, Moon up", 40.7128, -74.006, "2026-10-30T14:00:00Z"], ["nyc day, Moon down", 40.7128, -74.006, "2026-10-30T19:00:00Z"],
    ["nyc civil twilight", 40.7128, -74.006, "2026-10-30T22:15:00Z"], ["nyc nautical twilight", 40.7128, -74.006, "2026-10-30T22:45:00Z"],
    ["nyc astronomical twilight", 40.7128, -74.006, "2026-10-30T23:15:00Z"], ["nyc night, Moon down (Ivar's screenshot)", 40.7128, -74.006, "2026-10-31T00:13:00Z"],
    ["nyc night, Moon up", 40.7128, -74.006, "2026-10-31T04:00:00Z"], ["nyc sunrise", 40.7128, -74.006, "2026-10-30T11:35:00Z"],
    ["nyc 21:26, Ivar's gaps", 40.7128, -74.006, "2026-10-31T01:26:00Z"],
    ["Tromsø polar night", 69.6492, 18.9553, "2026-12-15T10:45:00Z"], ["Tromsø polar day", 69.6492, 18.9553, "2026-06-21T22:30:00Z"],
    ["Sydney", -33.8688, 151.2093, "2026-10-30T02:00:00Z"], ["Singapore, Sun near the zenith", 1.3521, 103.8198, "2026-09-23T04:55:00Z"],
  ]
  const PERIOD = { sun: 864e5, moon: 89428e3 }, TURN: string[] = []
  const get = async (path: string) => (await handler(new Request(`https://ephem.example${path}`))).json()
  for (const [name, lat, lon, at] of STATES) it(name, async () => {
    const now = Date.parse(at), D = Math.floor(now / 864e5), iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z"
    const pos = await get(`/v1/position?lat=${lat}&lon=${lon}&time=${at}`)
    const tr = await get(`/v1/track?lat=${lat}&lon=${lon}&start=${iso((D - 1) * 864e5)}&end=${iso((D + 2) * 864e5)}`)
    const s0 = Date.parse(tr.start)
        const bodies = (["sun", "moon"] as const).map(k => {
      const b = pos[k], pts: Array<{ t: number; az: number; alt: number }> = []
      for (let i = 0; i < tr.count; i++) pts.push({ t: s0 + i * tr.stepSeconds * 1000, az: tr[k].azimuth[i], alt: ch.chartAlt(tr[k].altitude[i]) })
      const nowIdx = pts.findIndex(p => p.t > now); pts.splice(nowIdx, 0, { t: now, az: b.azimuth, alt: ch.chartAlt(b.altitude) })
      return { key: k, name: k === "sun" ? "Sun" : "Moon", az: b.azimuth, alt: ch.chartAlt(b.altitude), r: k === "sun" ? 5 : 6, pts, nowIdx, period: PERIOD[k] }
    })
    // the timeline: labels in one row above and one below, never overlapping; no leader crosses any label
    const tz = name.startsWith("Tromsø") ? "Europe/Oslo" : name.startsWith("Sydney") ? "Australia/Sydney" : name.startsWith("Singapore") ? "Asia/Singapore" : "America/New_York"
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(now)), day = await get(`/v1/day?lat=${lat}&lon=${lon}&date=${date}&tz=${encodeURIComponent(tz)}`)
    const ds = Date.parse(day.start), dspan = Date.parse(day.end) - ds
    const sunS: Array<{ t: number; alt: number }> = []; for (let i = 0; i < tr.count; i++) { const t = s0 + i * tr.stepSeconds * 1000; if (t >= ds - 12e5 && t <= ds + dspan + 12e5) sunS.push({ t, alt: tr.sun.altitude[i] }) }
    const evs = day.events.map((e: { body: string; kind: string; time: string }) => ({ body: e.body, kind: e.kind, t: Date.parse(e.time) }))
    const nx = evs.filter((e: { t: number }) => e.t > now)[0] ?? null
    for (const w of [358, 343]) {
      const L = ch.timelineLayout(evs, sunS, ds, dspan, w, now, nx, e => e.kind.toUpperCase(), t => new Date(t).toISOString().slice(11, 16), (t, k) => Math.ceil(t.length * (k === "name" ? 6.4 : 6.6)) + 4)
      expect(new Set(L.labels.map(l => l.y)).size, `${name} ${w}: label rows`).toBeLessThanOrEqual(2)
      for (let i = 0; i < L.labels.length; i++) {
        const a = L.labels[i]!
        expect(a.x).toBeGreaterThanOrEqual(0); expect(a.x + a.w).toBeLessThanOrEqual(w)
        for (let j = i + 1; j < L.labels.length; j++) expect(ch.overlapArea(a, L.labels[j]!), `${name} ${w}: labels ${i} x ${j}`).toBe(0)
        for (const ld of L.leaders) expect(ch.segHitsRect(ld, a), `${name} ${w}: a leader crosses label ${i}`).toBe(false)
      }
    }
    for (const [W, H] of [[390, 354.5], [375, 280.1]] as const) {
      const st = { W, H, insetL: 0, insetR: 0, center: ch.chartCenter(lat, [pos.sun.azimuth, pos.moon.azimuth]), now, ctl: { id: "ctl", x: W - 44, y: 0, w: 44, h: 44 }, pose: null,
        meas: (t: string) => Math.ceil(t.length * 7.2) + 2, lh: 15, bodies }
      const m = ch.skyModel(st), where = `${name} ${W}x${H}`
      // tracks: one polyline per body, inside the frame, no jumps, both ends on the frame's edges
      for (const k of ["sun", "moon"]) {
        const l = m.lines[k]!
        expect(l.xs.length, `${where}: ${k} track`).toBeGreaterThan(30)
        for (let i = 0; i < l.xs.length; i++) { expect(l.xs[i]!).toBeGreaterThanOrEqual(-0.001); expect(l.xs[i]!).toBeLessThanOrEqual(W + 0.001) }
        for (let i = 1; i < l.xs.length; i++) expect(Math.abs(l.xs[i]! - l.xs[i - 1]!), `${where}: ${k} jump at ${i}`).toBeLessThan(W / 4)
        // smooth: no kink. The direction's turn at a sample may be large where the curve really bends (a culmination, the
        // zenith), but it changes smoothly along the track: a kink is a turn that stands out from its neighbours' (the old
        // piecewise scale bent every track by ~20-40° at -18° between two straight pieces).
        let worst = 0
        const turn: number[] = []
        for (let i = 1; i < l.xs.length - 1; i++) {
          const a1 = Math.atan2(l.ys[i]! - l.ys[i - 1]!, l.xs[i]! - l.xs[i - 1]!), a2 = Math.atan2(l.ys[i + 1]! - l.ys[i]!, l.xs[i + 1]! - l.xs[i]!)
          const seg = Math.min(Math.hypot(l.xs[i]! - l.xs[i - 1]!, l.ys[i]! - l.ys[i - 1]!), Math.hypot(l.xs[i + 1]! - l.xs[i]!, l.ys[i + 1]! - l.ys[i]!))
          turn.push(seg < 1.5 || l.ys[i]! < m.g.top + 15 * m.g.ky ? NaN : ((a2 - a1) * 180 / Math.PI + 540) % 360 - 180)
        }
                for (let i = 1; i < turn.length - 1; i++) if (![turn[i - 1], turn[i], turn[i + 1]].some(Number.isNaN)) worst = Math.max(worst, Math.abs(turn[i]! - (turn[i - 1]! + turn[i + 1]!) / 2))
        TURN.push(`${where} ${k} ${worst.toFixed(1)}`)
        expect(worst, `${where}: ${k} kinks by ${worst.toFixed(1)}°`).toBeLessThan(6)
        const ends = [l.xs[0]!, l.xs[l.xs.length - 1]!], low = [l.ys[0]!, l.ys[l.ys.length - 1]!]
        const round = Math.min(...ends) < 0.01 && Math.max(...ends) > W - 0.01   // a full revolution: one end on each edge
        // or (azimuth not all the way round, |dec| > |lat|) a loop cut at its lowest point: ends together, deep below the horizon
        const loop = Math.hypot(ends[0]! - ends[1]!, low[0]! - low[1]!) < 12 && Math.min(...low) > H * 0.8
        expect(round || loop, `${where}: ${k} ends (${ends.map(x => x.toFixed(1))}, ${low.map(y => y.toFixed(1))})`).toBe(true)
      }
      // labels: both names, clear of each other, every disc and button, and every track (3 px to spare)
      const placed = ch.layoutLabels(m.items, m.hard, m.segs, m.bounds, 3), shown = placed.filter(p => !p.dropped)
      expect(shown.map(p => p.id), `${where}: both named`).toEqual(expect.arrayContaining(["Sun", "Moon"]))
      for (const a of shown) {
        expect(a.crossed, `${where}: ${a.id} fell back`).toBeUndefined()
        for (const h of m.hard) expect(ch.overlapArea(a, h), `${where}: ${a.id} on ${h.id}`).toBe(0)
        expect(m.segs.some(s => ch.segHitsRect(s, a)), `${where}: ${a.id} on a track`).toBe(false)
        for (const b of shown) if (b !== a) expect(ch.overlapArea(a, b)).toBe(0)
      }
    }
  })
})
