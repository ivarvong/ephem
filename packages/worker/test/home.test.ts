// The homepage route (src/home.ts): who the sky is for, the streamed document with the API's own first answers, every page's
// CSP and the no-inline-script rule as served, and the page's chart model (@ephem/web lib/chart.ts) over every sky state from
// the API's own answers. The UI's own tests: packages/web/test.
import { describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { assets } from "@ephem/web/server"
import { chartCenter, skyModel } from "@ephem/web/lib/chart"
import { layoutLabels, overlapArea, segHitsRect, isPlaced } from "@ephem/web/lib/labels"
import { timelineLayout } from "@ephem/web/lib/timeline"
import { makeHandler } from "../src/app.ts"
import { initialQueries, visitor } from "../src/home.ts"
import { REC, direct, makeBlocks } from "../src/blocks.ts"

const NYC = { latitude: "40.71427", longitude: "-74.00597", city: "New York City", region: "New York", country: "US", timezone: "America/New_York", colo: "EWR" }
const u = (q = "") => new URL("https://ephem.example/" + q)
const FIX = resolve(__dirname, "../../core/test/fixtures/blocks")
const fixtures = () => makeBlocks(direct(async (first, count) => {
  const out = new Uint8Array(count * REC)
  for (let i = 0; i < count; i++) out.set(readFileSync(`${FIX}/${first + i}.bin`), i * REC)
  return out.buffer
}))

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

describe("every page as served: a strict CSP, no inline executable script, no inline event handler", () => {
  const handler = makeHandler(fixtures())
  const scripts = (html: string) => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map(m => ({ attrs: m[1]!, body: m[2]! }))
  for (const path of ["/", "/?lat=69.65&lon=18.96&tz=Europe/Oslo&place=Troms%C3%B8&at=2026-12-15T10:45:00Z", "/docs", "/docs/interactive"]) it(path, async () => {
    const res = await handler(new Request(`https://ephem.example${path}`)), html = await res.text(), csp = res.headers.get("content-security-policy") ?? ""
    expect(res.status).toBe(200)
    expect(csp).toContain("default-src 'none'"); expect(csp).toContain("base-uri 'none'"); expect(csp).toContain("object-src 'none'")
    const scriptSrc = /script-src ([^;]*)/.exec(csp)?.[1] ?? ""
    expect(scriptSrc).not.toMatch(/unsafe-inline|unsafe-eval|nonce-|sha256-/)
    expect(res.headers.get("x-content-type-options")).toBe("nosniff")
    for (const s of scripts(html)) {
      if (/type="application\/json"/.test(s.attrs)) continue   // data, never executed
      expect(s.body, `${path}: inline script ${s.attrs}`).toBe("")
      expect(s.attrs).toMatch(/ src="(\/assets\/[^"]+\.js|https:\/\/cdn\.jsdelivr\.net\/npm\/@scalar\/[^"]+)"/)
    }
    expect([...html.matchAll(/<[a-z][^>]*\son[a-z]+\s*=/gi)].map(m => m[0])).toEqual([])
    expect(html).not.toMatch(/javascript:/i)
    if (path.startsWith("/?") || path === "/") {
      expect(csp).toContain(`style-src 'self' 'sha256-${assets().css.sha256}'`)
      expect([...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(m => m[1])).toEqual([assets().css.text])   // the one inline style is the build's
      expect(html).not.toMatch(/\sstyle="/)                                                                    // no style attributes
    }
  })
})

// One round trip (2026-10-31): the page streams its first-load answers, computed in-process through the router.
describe("home: first-load answers embedded in the streamed page", () => {
  const embedded = (html: string, id: string) => {
    const m = new RegExp(`<script type="application/json" id="${id}">(.*?)</script>`).exec(html)
    return m ? JSON.parse(m[1]!) : null
  }
  const strip = (x: { provenance?: unknown }) => ({ ...x, provenance: undefined })   // diagnostics carry timings
  it("embeds /v1/position, /v1/track, /v1/day and /v1/magnetic verbatim: the API's own answers to the page's own queries", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-31T00:13:00Z"))
    try {
      const handler = makeHandler(fixtures())
      const req = new Request("https://ephem.example/"); Object.defineProperty(req, "cf", { value: NYC })
      const res = await handler(req), html = await res.text()
      expect(res.headers.get("cache-control")).toBe("private, no-store")
      expect(html.indexOf('<div id="app">')).toBeLessThan(html.indexOf('id="ephem-position"'))   // the head and shell first, the data after
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
      expect(Q["ephem-track"][1]).toEqual({ lat: "40.71427", lon: "-74.00597", start: "2026-10-30T00:00:00Z", end: "2026-11-02T00:00:00Z" })
    } finally { vi.useRealTimers() }
  })
  it("an answer that fails is left out (the page fetches it); the page still completes", async () => {
    const handler = makeHandler(makeBlocks(async () => { throw new Error("R2 down") }))
    const req = new Request("https://ephem.example/"); Object.defineProperty(req, "cf", { value: NYC })
    const html = await (await handler(req)).text()
    expect(embedded(html, "ephem-position")).toBeNull()
    expect(html.endsWith("</body></html>")).toBe(true)
  })
})

// The sky chart (2026-10-31): one label per body (its name), laid out clear of every track, disc and button; each body's track
// one connected polyline spanning one revolution, both ends on the frame's edges. Run on the page's own model over every sky
// state, from the API's own answers (fixture DE440 blocks), at both phone sizes.
describe("home: the chart in every sky state", () => {
  const handler = makeHandler(fixtures())
  const STATES: Array<[string, number, number, string]> = [
    ["nyc day, Moon up", 40.7128, -74.006, "2026-10-30T14:00:00Z"], ["nyc day, Moon down", 40.7128, -74.006, "2026-10-30T19:00:00Z"],
    ["nyc civil twilight", 40.7128, -74.006, "2026-10-30T22:15:00Z"], ["nyc nautical twilight", 40.7128, -74.006, "2026-10-30T22:45:00Z"],
    ["nyc astronomical twilight", 40.7128, -74.006, "2026-10-30T23:15:00Z"], ["nyc night, Moon down (the reference screenshot)", 40.7128, -74.006, "2026-10-31T00:13:00Z"],
    ["nyc night, Moon up", 40.7128, -74.006, "2026-10-31T04:00:00Z"], ["nyc sunrise", 40.7128, -74.006, "2026-10-30T11:35:00Z"],
    ["nyc 21:26, the gaps case", 40.7128, -74.006, "2026-10-31T01:26:00Z"],
    ["Tromsø polar night", 69.6492, 18.9553, "2026-12-15T10:45:00Z"], ["Tromsø polar day", 69.6492, 18.9553, "2026-06-21T22:30:00Z"],
    ["Sydney", -33.8688, 151.2093, "2026-10-30T02:00:00Z"], ["Singapore, Sun near the zenith", 1.3521, 103.8198, "2026-09-23T04:55:00Z"],
  ]
  const PERIOD = { sun: 864e5, moon: 89428e3 }
  const get = async (path: string) => (await handler(new Request(`https://ephem.example${path}`))).json()
  for (const [name, lat, lon, at] of STATES) it(name, async () => {
    const now = Date.parse(at), D = Math.floor(now / 864e5), iso = (ms: number) => new Date(ms).toISOString().slice(0, 19) + "Z"
    const pos = await get(`/v1/position?lat=${lat}&lon=${lon}&time=${at}`)
    const tr = await get(`/v1/track?lat=${lat}&lon=${lon}&start=${iso((D - 1) * 864e5)}&end=${iso((D + 2) * 864e5)}`)
    const s0 = Date.parse(tr.start)
    const bodies = (["sun", "moon"] as const).map(k => {
      const b = pos[k], pts: Array<{ t: number; az: number; alt: number }> = []
      for (let i = 0; i < tr.count; i++) pts.push({ t: s0 + i * tr.stepSeconds * 1000, az: tr[k].azimuth[i], alt: tr[k].altitude[i] })
      const nowIdx = pts.findIndex(p => p.t > now); pts.splice(nowIdx, 0, { t: now, az: b.azimuth, alt: b.altitude })
      return { key: k, name: k === "sun" ? "Sun" : "Moon", az: b.azimuth, alt: b.altitude, r: k === "sun" ? 5 : 6, pts, nowIdx, period: PERIOD[k] }
    })
    // the timeline: labels in one row above and one below, never overlapping; no leader crosses any label
    const tz = name.startsWith("Tromsø") ? "Europe/Oslo" : name.startsWith("Sydney") ? "Australia/Sydney" : name.startsWith("Singapore") ? "Asia/Singapore" : "America/New_York"
    const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(now)), day = await get(`/v1/day?lat=${lat}&lon=${lon}&date=${date}&tz=${encodeURIComponent(tz)}`)
    const ds = now - 3 * 3600e3, dspan = 24 * 3600e3
    const sunS: Array<{ t: number; alt: number }> = []
    for (let i = 0; i < tr.count; i++) { const t = s0 + i * tr.stepSeconds * 1000; if (t >= ds - 12e5 && t <= ds + dspan + 12e5) sunS.push({ t, alt: tr.sun.altitude[i] }) }
    const evs = day.events.map((e: { body: "sun" | "moon"; kind: string; time: string }) => ({ body: e.body, kind: e.kind, t: Date.parse(e.time) }))
    const nx = evs.filter((e: { t: number }) => e.t > now)[0] ?? null
    for (const w of [358, 343]) {
      const L = timelineLayout(evs, sunS, ds, dspan, w, now, nx, e => e.kind.toUpperCase(), t => new Date(t).toISOString().slice(11, 16), (t, k) => Math.ceil(t.length * (k === "name" ? 6.4 : 6.6)) + 4)
      expect(new Set(L.labels.map(l => l.y)).size, `${name} ${w}: label rows`).toBeLessThanOrEqual(2)
      for (let i = 0; i < L.labels.length; i++) {
        const a = L.labels[i]!
        expect(a.x).toBeGreaterThanOrEqual(0); expect(a.x + a.w).toBeLessThanOrEqual(w)
        for (let j = i + 1; j < L.labels.length; j++) expect(overlapArea(a, L.labels[j]!), `${name} ${w}: labels ${i} x ${j}`).toBe(0)
        for (const ld of L.leaders) expect(segHitsRect(ld, a), `${name} ${w}: a leader crosses label ${i}`).toBe(false)
      }
    }
    for (const [W, H] of [[390, 354.5], [375, 280.1]] as const) {
      const m = skyModel({ W, H, insetL: 0, insetR: 0, center: chartCenter(lat, [pos.sun.azimuth, pos.moon.azimuth]), now, ctl: { id: "ctl", x: W - 44, y: 0, w: 44, h: 44 }, pose: null,
        meas: (t: string) => Math.ceil(t.length * 7.2) + 2, lh: 15, bodies }), where = `${name} ${W}x${H}`
      for (const k of ["sun", "moon"] as const) {
        const l = m.lines[k]!
        expect(l.xs.length, `${where}: ${k} track`).toBeGreaterThan(30)
        for (let i = 0; i < l.xs.length; i++) { expect(l.xs[i]!).toBeGreaterThanOrEqual(-0.001); expect(l.xs[i]!).toBeLessThanOrEqual(W + 0.001) }
        for (let i = 1; i < l.xs.length; i++) expect(Math.abs(l.xs[i]! - l.xs[i - 1]!), `${where}: ${k} jump at ${i}`).toBeLessThan(W / 4)
        // smooth: a kink is a turn that stands out from its neighbours' (the old piecewise scale bent every track at -18°)
        let worst = 0
        const turn: number[] = []
        for (let i = 1; i < l.xs.length - 1; i++) {
          const a1 = Math.atan2(l.ys[i]! - l.ys[i - 1]!, l.xs[i]! - l.xs[i - 1]!), a2 = Math.atan2(l.ys[i + 1]! - l.ys[i]!, l.xs[i + 1]! - l.xs[i]!)
          const seg = Math.min(Math.hypot(l.xs[i]! - l.xs[i - 1]!, l.ys[i]! - l.ys[i - 1]!), Math.hypot(l.xs[i + 1]! - l.xs[i]!, l.ys[i + 1]! - l.ys[i]!))
          turn.push(seg < 1.5 || l.ys[i]! < m.g.top + 15 * m.g.ky ? NaN : ((a2 - a1) * 180 / Math.PI + 540) % 360 - 180)
        }
        for (let i = 1; i < turn.length - 1; i++) if (![turn[i - 1], turn[i], turn[i + 1]].some(Number.isNaN)) worst = Math.max(worst, Math.abs(turn[i]! - (turn[i - 1]! + turn[i + 1]!) / 2))
        expect(worst, `${where}: ${k} kinks by ${worst.toFixed(1)}°`).toBeLessThan(6)
        const ends = [l.xs[0]!, l.xs[l.xs.length - 1]!], low = [l.ys[0]!, l.ys[l.ys.length - 1]!]
        const round = Math.min(...ends) < 0.01 && Math.max(...ends) > W - 0.01
        const loop = Math.hypot(ends[0]! - ends[1]!, low[0]! - low[1]!) < 12 && Math.min(...low) > H * 0.8
        expect(round || loop, `${where}: ${k} ends (${ends.map(x => x.toFixed(1))}, ${low.map(y => y.toFixed(1))})`).toBe(true)
      }
      const shown = layoutLabels(m.items, m.hard, m.segs, m.bounds, 3).filter(isPlaced)
      expect(shown.map(p => p.id), `${where}: both named`).toEqual(expect.arrayContaining(["Sun", "Moon"]))
      for (const a of shown) {
        expect(a.crossed, `${where}: ${a.id} fell back`).toBeUndefined()
        for (const h of m.hard) expect(overlapArea(a, h), `${where}: ${a.id} on ${h.id}`).toBe(0)
        expect(m.segs.some(s => segHitsRect(s, a)), `${where}: ${a.id} on a track`).toBe(false)
        for (const b of shown) if (b !== a) expect(overlapArea(a, b)).toBe(0)
      }
    }
  })
})
