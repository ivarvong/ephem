import { describe, expect, it } from "vitest"
import fc from "fast-check"
import { makeHandler } from "../src/app.ts"
import { CORE_JS, page, visitor } from "../src/home.ts"
import { makeBlocks } from "../src/blocks.ts"

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
    expect(html).toMatch(/<details class="hood" id="hood">\s*<summary>Under the hood<\/summary>/)
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
    expect(uses.length).toBeLessThanOrEqual(3)   // altOf itself, the null-checked readout value, the null-checked aria value
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
  it("the page loads no web fonts or external stylesheets (system stacks only)", () => {
    const html = page(V)
    expect(html).not.toMatch(/<link[^>]+stylesheet/); expect(html).not.toContain("fonts.googleapis")
  })
})
