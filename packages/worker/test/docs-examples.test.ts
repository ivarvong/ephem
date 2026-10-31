// Every example in /docs, /llms.txt and docs/API.md, run through the real handler (committed DE440 blocks, the real METAR
// file), and checked against what the docs say it answers (sweep 2026-10-31). Examples are scraped from the rendered text,
// so a new example is run without editing this file.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { makeHandler } from "../src/app.ts"
import { direct, makeBlocks } from "../src/blocks.ts"
import { makeFeed, serveFeed } from "../src/metar-feed.ts"
import { weatherLive } from "../src/weather.ts"
import { BASE, docsHtml, llmsTxt } from "../src/docs.ts"
import { parseObstacles, parseProfile } from "@ephem/core"

const FIX = resolve(__dirname, "../../core/test/fixtures/blocks")
const gz = readFileSync(resolve(__dirname, "fixtures/metars-2026-10-29T1123Z.csv.gz"))
const feed = makeFeed({ fetch: req => serveFeed(req, { fetch: async () => new Response(gz.slice(), { headers: { etag: '"x"', "last-modified": "Thu, 29 Oct 2026 11:25:16 GMT" } }), log: () => {} }) })
const handler = makeHandler(makeBlocks(direct(async first => { const b = readFileSync(`${FIX}/${first}.bin`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer })), undefined, weatherLive(feed))
const API_MD = readFileSync(resolve(__dirname, "../../../docs/API.md"), "utf8")
const unescape = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")

/** GET paths and POST bodies quoted as examples in a text. */
const scrape = (text: string) => {
  const t = unescape(text), gets = new Set<string>(), posts: Array<{ path: string; body: string }> = []
  for (const m of t.matchAll(/curl -X POST [^\n]*?https:\/\/ephem\.ivar\.workers\.dev(\/[\w/]+) -d '([^']+)'/g)) posts.push({ path: m[1]!, body: m[2]! })
  for (const m of t.matchAll(/curl '(?:https:\/\/ephem\.ivar\.workers\.dev)(\/[^']+)'/g)) gets.add(m[1]!)
  for (const m of t.matchAll(/example: https:\/\/ephem\.ivar\.workers\.dev(\/\S+)/g)) gets.add(m[1]!)
  for (const m of t.matchAll(/Example: <a href="([^"]+)">/g)) gets.add(m[1]!)
  return { gets, posts }
}
const SOURCES = { "/docs": scrape(docsHtml()), "/llms.txt": scrape(llmsTxt()), "docs/API.md": scrape(API_MD) }
const ALL_GETS = [...new Set(Object.values(SOURCES).flatMap(s => [...s.gets]))].toSorted()
const ALL_POSTS = [...new Map(Object.values(SOURCES).flatMap(s => s.posts).map(p => [p.path + p.body, p])).values()]

const get = async (p: string) => { const r = await handler(new Request("http://x" + p)); return { status: r.status, j: await r.json() as any } }
const post = async (path: string, body: string) => { const r = await handler(new Request("http://x" + path, { method: "POST", headers: { "content-type": "application/json" }, body })); return { status: r.status, j: await r.json() as any } }
const q = (p: string) => new URL("http://x" + p).searchParams

/** What each endpoint's docs say its answer is: one check per path. */
const CLAIMS: Record<string, (j: any, path: string) => void> = {
  "/position": (j, p) => {   // "Topocentric Sun and Moon at one instant (default now)"
    if (q(p).has("time")) expect(j.time.utc).toBe(new Date(q(p).get("time")!).toISOString())
    else expect(Math.abs(Date.parse(j.time.utc) - Date.now())).toBeLessThan(5_000)
    for (const b of [j.sun, j.moon]) { expect(b.azimuth).toBeGreaterThanOrEqual(0); expect(b.azimuth).toBeLessThan(360); expect(typeof b.altitudeRate).toBe("number") }
    expect(j.moon.phase.illuminatedFraction).toBeGreaterThanOrEqual(0); expect(j.moon).toHaveProperty("brightLimbAngleFromVertical")
  },
  "/track": async (j, p) => {   // "on a UTC grid (≤ 8 days, ≤ 1 441 samples) … each sample equals /position at that instant"
    expect(j.count).toBeLessThanOrEqual(1441); expect(j.sun.azimuth).toHaveLength(j.count)
    for (const i of [0, j.count >> 1, j.count - 1]) {
      const t = new Date(Date.parse(j.start) + i * j.stepSeconds * 1000).toISOString(), s = q(p)
      const pos = (await get(`/position?lat=${s.get("lat")}&lon=${s.get("lon")}&time=${t}`)).j
      expect(j.sun.azimuth[i]).toBe(pos.sun.azimuth); expect(j.moon.altitude[i]).toBe(pos.moon.altitude)
    }
  },
  "/day": j => {   // "Rise, set, transit, civil / nautical / astronomical twilight, golden and blue hour … sorted by time"
    const kinds = new Set(j.events.map((e: any) => `${e.body}.${e.kind}`))
    for (const k of ["sun.rise", "sun.set", "sun.transit", "sun.civilDawn", "sun.nauticalDusk", "sun.astronomicalDawn", "sun.goldenHourStart", "sun.blueHourEnd", "moon.transit"]) expect(kinds, k).toContain(k)
    const ts = j.events.map((e: any) => Date.parse(e.time)); expect(ts).toEqual(ts.toSorted((a: number, b: number) => a - b))
    expect(j.conventions.riseSet).toHaveProperty("aim")
  },
  "/crossing": (j, p) => {   // "Every instant … when the centre, a limb … reaches a true or apparent altitude"
    expect(j.crossings.length).toBeGreaterThan(0)
    const dir = q(p).get("direction"); if (dir) for (const c of j.crossings) expect(c.direction).toBe(dir)
    expect(j.conventions.altitudeType).toBe(q(p).get("altitudeType") ?? "true")
  },
  "/alignment": (j, p) => {   // "Where do I stand so the body sits on a landmark?" — a standing point per instant, within maxDistanceKm
    expect(j.track.length).toBeGreaterThan(0)
    for (const pt of j.track) expect(pt.distanceKm).toBeLessThanOrEqual(Number(q(p).get("maxDistanceKm") ?? 20))
  },
  "/sightline": (j, p) => {   // "height above sea level against ground distance … and the clearance over obstacle points"
    expect(j.profile).toHaveLength(Number(q(p).get("samples") ?? 101))
    for (const o of j.obstacles) { expect(o.clearanceM).toBeCloseTo(o.lineHeightMsl - o.heightMsl, 9); expect(typeof o.blocks).toBe("boolean") }
    expect(j.obstacles[0].lineHeightMsl).toBeGreaterThan(22); expect(j.obstacles[0].lineHeightMsl).toBeLessThan(34)   // "22–28 m over the island" (customer)
  },
  "/magnetic": j => { expect(j.magnetic.model).toBe("WMM2025"); expect(j.magnetic.declination).toBeGreaterThan(-14); expect(j.magnetic.declination).toBeLessThan(-11); expect(j.magnetic.compass).toBe("ok") },   // NYC ≈ −12.5° W
  "/weather": (j, p) => {   // "Nearest METAR stations, decoded, with distance and true / magnetic bearing"
    expect(j.stations).toHaveLength(Number(q(p).get("count") ?? 3))
    const d = j.stations.map((s: any) => s.distanceKm); expect(d).toEqual(d.toSorted((a: number, b: number) => a - b))
    for (const s of j.stations) { expect(s.raw).toMatch(/^METAR|^SPECI|^[A-Z0-9]{4} /); expect(s.bearing).toHaveProperty("magnetic") }
  },
  "/healthz": j => expect(j.ok).toBe(true),
}

describe("every documented example returns what the docs say", () => {
  beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-11-16T12:00:00Z")) })   // "now" inside the committed blocks
  afterAll(() => { vi.useRealTimers() })
  it("each source has examples, and API.md's are the /docs quickstart", () => {
    for (const [name, s] of Object.entries(SOURCES)) expect(s.gets.size, name).toBeGreaterThanOrEqual(3)
    for (const p of SOURCES["docs/API.md"].gets) expect(SOURCES["/docs"].gets, p).toContain(p)
    expect(ALL_POSTS.length).toBeGreaterThanOrEqual(1)
    expect(BASE).toBe("https://ephem.ivar.workers.dev")
  })
  it.each(ALL_GETS.map(p => [p] as const))("GET %s", async p => {
    const { status, j } = await get(p)
    expect(status, JSON.stringify(j).slice(0, 300)).toBe(200)
    if (p !== "/healthz") { expect(j, "every response carries conventions").toHaveProperty("conventions"); expect(j, "and provenance").toHaveProperty("provenance") }
    const path = new URL("http://x" + p).pathname, claim = CLAIMS[path]
    expect(claim, `no claim check for ${path}`).toBeDefined()
    await claim!(j, p)
  }, 30_000)
  it.each(ALL_POSTS.map(x => [x.path, x] as const))("POST %s", async (_p, x) => {   // "every pass … exact entry / exit … filters maxSunAltitude"
    const { status, j } = await post(x.path, x.body), b = JSON.parse(x.body)
    expect(status, JSON.stringify(j).slice(0, 300)).toBe(200)
    expect(j.passes.length).toBeGreaterThan(0); expect(j).toHaveProperty("conventions"); expect(j).toHaveProperty("provenance")
    for (const pass of j.passes) {
      expect(pass.segments.length).toBeGreaterThan(0)
      if (b.maxSunAltitude !== undefined) expect(pass.sunAltitude).toBeLessThanOrEqual(b.maxSunAltitude)
      for (const s of pass.segments) expect(Date.parse(s.exit.time)).toBeGreaterThanOrEqual(Date.parse(s.enter.time))
    }
  }, 60_000)
})

describe("claims in the prose of docs/API.md and /llms.txt", () => {
  it("the quoted 400 message, the did-you-mean hints and the 404 are what the API says", async () => {
    const quoted = /For example: `([^`]+)`/.exec(API_MD)![1]!
    const r = await get("/position?lat=100&lon=-74&time=2026-11-16T12:00:00Z")
    expect(r.status).toBe(400); expect(r.j).toMatchObject({ _tag: "InvalidRequest", parameter: "lat" }); expect(r.j.message).toBe(quoted)
    expect((await get("/alignment?body=moon&targetLat=40.68925&targetLon=-74.0445&targetHeight=70&observerHeight=5&start=2026-11-17T03:44:30Z&end=2026-11-17T03:46:00Z")).j.message).toMatch(/observerHeight.*height/)
    expect((await get("/day?lat=40.7&lon=-74&date=2026-11-16&tz=America/New_York&temprature=5")).j.message).toMatch(/temprature.*temperature/)
    const nf = await get("/nope"); expect(nf.status).toBe(404); expect(nf.j).toMatchObject({ _tag: "NotFound" })
    for (const e of ["/position", "/track", "/day", "/crossing", "/alignment", "/sightline", "/magnetic", "/weather"]) expect(JSON.stringify(nf.j)).toContain(e)
  })
  it("the parameter docs' own e.g. values are accepted", () => {
    const llms = llmsTxt()
    const prof = /horizonProfile: [^\n]*?e\.g\. ([\d.:,-]+)/.exec(llms)![1]!.replace(/[,;]$/, ""), obs = /obstacles: [^\n]*?e\.g\. ([\d.:,-]+)/.exec(llms)![1]!.replace(/\.$/, "")
    expect(typeof parseProfile(prof), prof).toBe("object"); expect(Array.isArray(parseObstacles(obs)), obs).toBe(true)
    for (const m of llms.matchAll(/e\.g\. (\d{4}-\d\d-\d\dT[\d:]+Z)/g)) expect(Number.isFinite(Date.parse(m[1]!))).toBe(true)
  })
})
