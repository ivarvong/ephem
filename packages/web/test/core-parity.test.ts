// The homepage's in-browser compute is @ephem/core bundled by Vite (packages/web/src/client/core.ts → the web build's core
// module). Parity: that built file (imported as the browser imports it) vs the API's server path (core's positionRequest /
// trackRequest / dayRequest, the functions the handlers call) on thousands of random cases, 1900–2150, every latitude, both
// bodies, every output field, within tolerances far inside the accuracy bars (not bit-equality: V8 and JavaScriptCore may
// differ in Math's last bit; scripts/obs/sky-parity-chrome.ts runs the same comparison in real Chrome). What the module
// carries (no geoid, WMM or search): test/build.test.ts.
import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { DE440, dayRequest, positionRequest, trackRequest } from "@ephem/core"
import { diskBlocks } from "../../core/test/helpers/blocks.ts"

// Blocks: the full local DE440 file (data/jpl, linked into deploy.sh's worktree) when present, else the per-block cache.
const FILE = resolve(__dirname, "../../../data/jpl", DE440.file)
const whole = existsSync(FILE) ? readFileSync(FILE) : undefined
const memo = new Map<number, ArrayBuffer>()
const src = (i: number): ArrayBuffer => {
  let b = memo.get(i); if (b) return b
  b = whole ? whole.buffer.slice(whole.byteOffset + (2 + i) * DE440.recBytes, whole.byteOffset + (3 + i) * DE440.recBytes) as ArrayBuffer : diskBlocks(i)
  memo.set(i, b); return b
}
const DIST = resolve(__dirname, "../dist"), manifest = JSON.parse(readFileSync(resolve(DIST, "assets.json"), "utf8"))
const browser = await import(pathToFileURL(resolve(DIST, "client", manifest.core.js.slice(1))).href) as {
  position: (s: typeof src, q: object) => any; track: (s: typeof src, q: object) => any; day: (s: typeof src, q: object) => any
}

// seeded, so a failure replays (SKY_PARITY_SEED overrides)
const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const SEED = Number(process.env.SKY_PARITY_SEED ?? 20261031)
const T0 = Date.parse("1900-01-02T00:00:00Z"), T1 = Date.parse("2150-12-30T00:00:00Z")

/** Largest |a − b| per field path over every numeric leaf (angles wrapped), plus any structural mismatch. */
const ANGLE = /azimuth$|ongitude$|Angle$|elongation$|brightLimbAngleFromVertical$/
const diff = (a: unknown, b: unknown, path: string, max: Map<string, number>, bad: string[]) => {
  const key = path.replace(/\[\d+\]/g, "[]")
  if (typeof a === "number" && typeof b === "number") {
    let d = Math.abs(a - b); if (ANGLE.test(key)) d = Math.abs(((a - b) % 360 + 540) % 360 - 180)
    max.set(key, Math.max(max.get(key) ?? 0, d)); return
  }
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") { if (a !== b) bad.push(`${path}: ${String(a)} vs ${String(b)}`); return }
  for (const k of Object.keys(a)) diff((a as any)[k], (b as any)[k], path ? `${path}.${k}` : k, max, bad)
}
const TOL = (k: string) => (k.endsWith("distanceKm") ? 1e-6 : 1e-9)   // km; else days (86 µs), degrees, deg/min, hours
const inputs = (o: any) => ({ geo: { lat: o.observer.lat, lon: o.observer.lon, height: o.observer.heightEllipsoid } })

describe("parity: the built browser core vs the API's server path", () => {
  const report: string[] = []
  it("position: 4 000 random instants 1900–2150, every latitude, Sun and Moon, every field", () => {
    const r = rng(SEED), max = new Map<string, number>(), bad: string[] = []
    for (let n = 0; n < 4000; n++) {
      const utcMs = Math.round(T0 + r() * (T1 - T0)), lat = -90 + 180 * r(), lon = -180 + 360 * r()
      const api = positionRequest(src, { utcMs, lat, lon })
      const mine = browser.position(src, { utcMs, ...inputs(api), temperature: api.conventions.refraction.temperatureC, pressure: api.conventions.refraction.pressureHpa, horizon: api.conventions.horizon.altitude })
      diff({ time: mine.time, sun: mine.sun, moon: mine.moon }, { time: api.time, sun: api.sun, moon: api.moon }, "", max, bad)
    }
    expect(bad).toEqual([])
    expect(max.size).toBeGreaterThanOrEqual(30)
    for (const [k, v] of max) expect(v, k).toBeLessThanOrEqual(TOL(k))
    report.push(`position 4000 cases, ${max.size} fields: max |Δ| ${Math.max(...max.values())} (per field: ${[...max].map(([k, v]) => `${k} ${v}`).join(", ")})`)
  }, 120_000)
  it("track: 300 random windows (1–72 h at 20 min), every sample", () => {
    const r = rng(SEED + 1), max = new Map<string, number>(), bad: string[] = []
    for (let n = 0; n < 300; n++) {
      const startMs = Math.round((T0 + r() * (T1 - T0 - 4 * 864e5)) / 1200e3) * 1200e3, endMs = startMs + (1 + Math.floor(r() * 216)) * 1200e3
      const lat = -90 + 180 * r(), lon = -180 + 360 * r()
      const api = trackRequest(src, { lat, lon, startMs, endMs, stepSeconds: 1200 })
      const mine = browser.track(src, { startMs, endMs, stepMs: 1200e3, ...inputs(api), temperature: api.conventions.refraction.temperatureC, pressure: api.conventions.refraction.pressureHpa, horizon: api.conventions.horizon.altitude })
      expect(mine.count).toBe(api.count)
      diff({ sun: mine.sun, moon: mine.moon }, { sun: api.sun, moon: api.moon }, "", max, bad)
    }
    expect(bad).toEqual([])
    for (const [k, v] of max) expect(v, k).toBeLessThanOrEqual(TOL(k))
    report.push(`track 300 windows: max |Δ| ${Math.max(...max.values())}`)
  }, 120_000)
  it("day: 300 random local days in 12 zones, every event", () => {
    const r = rng(SEED + 2), zones = ["UTC", "America/New_York", "Europe/Oslo", "Asia/Kolkata", "Australia/Sydney", "Pacific/Auckland", "Pacific/Kiritimati", "Pacific/Pago_Pago", "America/St_Johns", "Asia/Kathmandu", "Antarctica/McMurdo", "Arctic/Longyearbyen"]
    let events = 0, maxMs = 0
    for (let n = 0; n < 300; n++) {
      const date = new Date(T0 + 864e5 + r() * (T1 - T0 - 3 * 864e5)).toISOString().slice(0, 10), tz = zones[Math.floor(r() * zones.length)]!, lat = -90 + 180 * r(), lon = -180 + 360 * r()
      const api = dayRequest(src, { date, tz, lat, lon })
      if (!("ok" in api)) continue   // a date the zone skipped
      const o = api.ok, mine = browser.day(src, { date, tz, ...inputs(o), temperature: o.conventions.riseSet.refraction.temperatureC, pressure: o.conventions.riseSet.refraction.pressureHpa, horizon: o.conventions.riseSet.horizon.altitude, limb: o.conventions.riseSet.aim.point })
      expect(mine.events.map((e: any) => e.body + e.kind)).toEqual(o.events.map(e => e.body + e.kind))
      mine.events.forEach((e: any, i: number) => { events++; maxMs = Math.max(maxMs, Math.abs(Date.parse(e.time) - Date.parse(o.events[i]!.time))) })
      expect([mine.start, mine.end]).toEqual([o.start, o.end])
    }
    expect(events).toBeGreaterThan(1500)
    expect(maxMs).toBeLessThanOrEqual(1)
    report.push(`day 300 days, ${events} events: max |Δ| ${maxMs} ms`)
    console.log(`browser core parity (seed ${SEED}): ${report.join("; ")}`)
  }, 120_000)
})
