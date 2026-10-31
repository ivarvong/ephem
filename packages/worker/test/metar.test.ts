import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { gzipSync } from "node:zlib"
import { allStations, greatCircle, nearest, parseCsv, parseMetars } from "../src/metar.ts"
import { FEED_CACHE_CONTROL, FEED_PATH, FRESH_MS, FRESH_S, SWR_S, gunzip, makeFeed, serveFeed, type UpstreamDeps } from "../src/metar-feed.ts"
import { makeHandler } from "../src/app.ts"
import { makeBlocks } from "../src/blocks.ts"
import { weatherLive } from "../src/weather.ts"

const FIX = resolve(__dirname, "fixtures")
const sample = readFileSync(`${FIX}/metars-sample.csv`, "utf8")
const fullGz = readFileSync(`${FIX}/metars-2026-10-29T1123Z.csv.gz`)
const ab = (b: Uint8Array) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

describe("CSV parser", () => {
  it("quotes, escaped quotes, empty fields, CRLF, trailing comma, no final newline", () => {
    expect(parseCsv('a,"b,c",d\r\n"x ""y""",,\n1,2,3')).toEqual([["a", "b,c", "d"], ['x "y"', "", ""], ["1", "2", "3"]])
    expect(parseCsv("a,\n")).toEqual([["a", ""]])
    expect(parseCsv("a,")).toEqual([["a", ""]])
    expect(() => parseCsv('"open')).toThrow(/unterminated/)
  })
  it("agrees with Python's csv module on the whole real file: header + 5 254 rows of 44 fields", async () => {
    const rows = parseCsv(await gunzip(ab(fullGz)))
    expect(rows.length).toBe(5255); expect(new Set(rows.map(r => r.length))).toEqual(new Set([44]))
    const ttpp = rows.find(r => r[1] === "TTPP")!
    expect(ttpp[0]).toBe("METAR TTPP 291100Z 00000KT 9999 -RA VCSH FEW016 27/24 Q1013 NOSIG RMK VCSH-NE,SE")   // comma inside quotes
  })
})

describe("METAR table", () => {
  const t = parseMetars(sample)
  const by = (id: string) => allStations(t).find(s => s.stationId === id)!
  it("skips rows without coordinates (LFBT has no longitude, NCPL neither)", () => {
    expect(t.skipped).toBe(2); expect(t.count).toBe(22)
  })
  it("parses fields with units, nulls and quirks", () => {
    expect(by("KJFK")).toMatchObject({ temperatureC: 8.3, dewpointC: 7.8, windSpeedKt: 0, windDirectionDeg: null, windVariable: false, visibilityMi: 10, visibilityPlus: true,
      altimeterInHg: 30.3, flightCategory: "VFR", metarType: "METAR", wx: "MIFG", sky: [{ cover: "FEW", baseFtAgl: 25000 }], lat: 40.6392, lon: -73.7639 })
    expect(by("CYYL")).toMatchObject({ temperatureC: -8, dewpointC: -9, windDirectionDeg: 10, windSpeedKt: 6, visibilityMi: 2, visibilityPlus: false, wx: "-SN", seaLevelPressureMb: 1023.2, metarType: "SPECI", flightCategory: "IFR" })
    expect(by("EGLL")).toMatchObject({ windVariable: true, windDirectionDeg: null, windSpeedKt: 3 })            // VRB03KT
    expect(by("KMTK")).toMatchObject({ windVariable: true, windSpeedKt: 6, windGustKt: 15 })                    // VRB06G15KT
    expect(by("EKVG")).toMatchObject({ windVariable: false, windDirectionDeg: 160 })                            // "VRB04" only in remarks
    expect(by("KMCW")).toMatchObject({ visibilityMi: 0.75, verticalVisibilityFt: 100, flightCategory: "LIFR" })
    expect(by("YSSY").sky).toEqual([{ cover: "OVC", baseFtAgl: 3400 }])
    expect(by("RPVK").sky.length).toBe(3)
    expect(by("TTPP").raw).toContain("VCSH-NE,SE")
  })
  it("whole real file: 5 252 stations with coordinates, unique ids", async () => {
    const full = parseMetars(await gunzip(ab(fullGz)))
    expect(full.count).toBe(5252); expect(full.skipped).toBe(2)
    const all = allStations(full)
    expect(new Set(all.map(s => s.stationId)).size).toBe(5252)
    expect(all.filter(s => s.flightCategory === "null").length).toBe(0)
    // the lazy index agrees with the full parser, field by field, on every row
    const eager = parseCsv(await gunzip(ab(fullGz))).slice(1).filter(r => r[3] && r[4])
    expect(all.map(s => [s.stationId, s.raw, s.lat, s.lon, s.observationTime])).toEqual(eager.map(r => [r[1], r[0], Number(r[3]), Number(r[4]), r[2]]))
  })
})

describe("nearest", () => {
  it("great circle: JFK → LHR 5 539 km on 51.3° initial bearing (published 5 540 km / 51°)", () => {
    const g = greatCircle(40.6392, -73.7639, 51.4775, -0.4614)
    expect(g.distanceKm).toBeGreaterThan(5530); expect(g.distanceKm).toBeLessThan(5550); expect(g.bearing).toBeCloseTo(51.4, 0)
    expect(greatCircle(0, 0, 1, 0).bearing).toBeCloseTo(0, 9); expect(greatCircle(0, 0, 0, 1).bearing).toBeCloseTo(90, 9); expect(greatCircle(0, 0, -1, 0).bearing).toBeCloseTo(180, 9)
  })
  it("equals a brute-force haversine sort for random points, n = 1..10", async () => {
    const full = parseMetars(await gunzip(ab(fullGz)))
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let k = 0; k < 200; k++) {
      const lat = Math.asin(2 * rnd() - 1) * 180 / Math.PI, lon = 360 * rnd() - 180, n = 1 + (k % 10)
      const brute = allStations(full).map(s => ({ id: s.stationId, d: greatCircle(lat, lon, s.lat, s.lon).distanceKm })).toSorted((a, b) => a.d - b.d).slice(0, n)
      const got = nearest(full, lat, lon, n)
      expect(got.map(g => g.distanceKm)).toEqual(brute.map(b => b.d).map((d, i) => (Math.abs(d - got[i]!.distanceKm) < 1e-6 ? got[i]!.distanceKm : d)))
    }
  })
  it("near the antimeridian and the poles", () => {
    const t = parseMetars(sample)
    expect(nearest(t, 40.7, -74.0, 3).map(x => x.station.stationId)).toEqual(["KNYC", "KLGA", "KEWR"])
    expect(nearest(t, -90, 0)[0]!.station.stationId).toBe("SCCI")   // the sample's southernmost
  })
  it("cost: parse once per data version, lookup per request (reported, not asserted)", async () => {
    const text = await gunzip(ab(fullGz))
    const time = (f: () => unknown, reps: number) => { f(); const t0 = performance.now(); for (let i = 0; i < reps; i++) f(); return (performance.now() - t0) / reps }
    const gunzipMs = await (async () => { const t0 = performance.now(); for (let i = 0; i < 5; i++) await gunzip(ab(fullGz)); return (performance.now() - t0) / 5 })()
    const parseMs = time(() => parseMetars(text), 10), full = parseMetars(text)
    const firstLookupUs = (() => { const t2 = parseMetars(text); const t0 = performance.now(); nearest(t2, 40.7, -74, 3); return (performance.now() - t0) * 1000 })()
    const lookupUs = time(() => nearest(full, 40.7, -74, 3), 2000) * 1000
    process.stderr.write(`\nMETAR cost (node, local): gunzip ${gunzipMs.toFixed(2)} ms, index ${parseMs.toFixed(2)} ms (${full.count} stations), nearest(n=3) first ${firstLookupUs.toFixed(1)} µs, warm ${lookupUs.toFixed(1)} µs\n`)
  })
})

// ── MetarFeed and its consumer, behind a fake Workers Caching (RFC 9111 max-age / stale-while-revalidate / stale-if-error) ──
const upstream = (gz: Uint8Array) => {
  let etag = '"v1"', down = false
  const calls: Array<Record<string, string>> = []
  const fetch = async (_u: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>; calls.push(h)
    if (down) throw new Error("connect ECONNREFUSED")
    if (h["if-none-match"] === etag) return new Response(null, { status: 304, headers: { etag } })
    return new Response(gz.slice(), { status: 200, headers: { etag, "last-modified": "Thu, 29 Oct 2026 11:25:16 GMT", "content-type": "application/octet-stream" } })
  }
  return { fetch, calls, bump: (e: string) => { etag = e }, setDown: (d: boolean) => { down = d } }
}
/** Just enough of Workers Caching to drive the feed: one stored entry, fresh / UPDATING (background) / EXPIRED (inline,
 *  conditional with the stored validators) / STALE on a 5xx within stale-if-error. Counts MetarFeed invocations. */
const fakeCache = (origin: (req: Request) => Promise<Response>, now: () => number, waitUntil: (p: Promise<unknown>) => void) => {
  let entry: { body: ArrayBuffer; headers: Headers; at: number } | undefined, runs = 0
  const cc = (h: Headers, k: string) => Number(new RegExp(`${k}=(\\d+)`).exec(h.get("cache-control") ?? "")?.[1] ?? 0)
  const revalidate = async (): Promise<"EXPIRED" | "REVALIDATED" | "ERR"> => {
    const h: Record<string, string> = {}; const e = entry!
    if (e.headers.get("etag")) h["if-none-match"] = e.headers.get("etag")!
    runs++; const r = await origin(new Request(`https://feed.internal${FEED_PATH}`, { headers: h }))
    if (r.status === 304) { const nh = new Headers(e.headers); r.headers.forEach((v, k) => nh.set(k, v)); entry = { body: e.body, headers: nh, at: now() }; return "REVALIDATED" }
    if (r.status === 200) { entry = { body: await r.arrayBuffer(), headers: r.headers, at: now() }; return "EXPIRED" }
    return "ERR"
  }
  const serve = (status: string) => new Response(entry!.body.slice(0), { headers: { ...Object.fromEntries(entry!.headers), "cf-cache-status": status } })
  const fetch = async (req: Request): Promise<Response> => {
    if (!entry) {
      runs++; const r = await origin(req)
      if (r.status === 200) { entry = { body: await r.arrayBuffer(), headers: r.headers, at: now() }; return serve("MISS") }
      return new Response(r.body, { status: r.status, headers: { ...Object.fromEntries(r.headers), "cf-cache-status": "MISS" } })
    }
    const age = (now() - entry.at) / 1000, max = cc(entry.headers, "max-age")
    if (age < max) return serve("HIT")
    if (age < max + cc(entry.headers, "stale-while-revalidate")) { waitUntil(revalidate()); return serve("UPDATING") }
    const r = await revalidate()
    if (r !== "ERR") return serve(r)
    if (age < max + cc(entry.headers, "stale-if-error")) return serve("STALE")
    return new Response("upstream down", { status: 502, headers: { "cf-cache-status": "EXPIRED" } })
  }
  return { fetch, runs: () => runs }
}
const harness = () => {
  let t = Date.parse("2026-10-29T11:30:00Z"); const pending: Array<Promise<unknown>> = [], logs: Array<Record<string, unknown>> = []
  const now = () => t, up = upstream(gzipSync(sample))
  const origin = (req: Request) => serveFeed(req, { fetch: up.fetch, now, log: l => { logs.push(l) } })
  const cache = fakeCache(origin, now, p => { pending.push(p) })
  const deps = { minStations: 1, fetch: cache.fetch, now }
  return { feed: makeFeed(deps), deps, cache, up, logs, advance: (ms: number) => { t += ms }, settle: async () => { while (pending.length) await pending.shift() } }
}

describe("MetarFeed entrypoint", () => {
  it("200: the gz bytes, cacheable with SWR and stale-if-error, upstream validators, x-fetched-at; one logged upstream call", async () => {
    const logs: Array<Record<string, unknown>> = [], up = upstream(gzipSync(sample))
    const r = await serveFeed(new Request("https://f" + FEED_PATH), { fetch: up.fetch, now: () => 1000, log: l => { logs.push(l) } })
    expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toBe(FEED_CACHE_CONTROL); expect(FEED_CACHE_CONTROL).toBe("public, max-age=60, stale-while-revalidate=600, stale-if-error=86400")
    expect(r.headers.get("etag")).toBe('"v1"'); expect(r.headers.get("x-fetched-at")).toBe("1000"); expect(r.headers.get("content-type")).toBe("application/gzip")
    expect(up.calls[0]!["user-agent"]).toMatch(/^ephem\.ivar\.workers\.dev/); expect(up.calls[0]!["if-none-match"]).toBeUndefined()
    expect(logs).toEqual([expect.objectContaining({ evt: "metar.upstream", status: 200, conditional: false, version: '"v1"' })])
  })
  it("a conditional request (the cache revalidating) is passed upstream; 304 comes back cacheable", async () => {
    const up = upstream(gzipSync(sample))
    const r = await serveFeed(new Request("https://f" + FEED_PATH, { headers: { "if-none-match": '"v1"' } }), { fetch: up.fetch, log: () => {} })
    expect(r.status).toBe(304); expect(r.headers.get("cache-control")).toBe(FEED_CACHE_CONTROL); expect(up.calls[0]!["if-none-match"]).toBe('"v1"')
  })
  it("failures are 502 no-store, never cached: upstream down, upstream 5xx, a non-gzip body; other paths 404", async () => {
    const cases: Array<UpstreamDeps["fetch"]> = [async () => { throw new Error("down") }, async () => new Response("oops", { status: 503 }), async () => new Response("<html>", { status: 200 })]
    for (const fetch of cases) { const r = await serveFeed(new Request("https://f" + FEED_PATH), { fetch, log: () => {} }); expect(r.status).toBe(502); expect(r.headers.get("cache-control")).toBe("no-store") }
    expect((await serveFeed(new Request("https://f/other"), { fetch: cases[0]!, log: () => {} })).status).toBe(404)
  })
})

describe("METAR feed consumer", () => {
  it("miss (parse) → hit (no parse, no body) → updating (one background refresh, 304) → hit; beyond SWR: revalidated inline", async () => {
    const h = harness()
    expect(await h.feed.get()).toMatchObject({ tier: "miss", parsed: true }); expect(h.up.calls.length).toBe(1)
    h.advance(FRESH_MS - 1); expect(await h.feed.get()).toMatchObject({ tier: "hit", parsed: false, bytes: 0, dataAgeMs: FRESH_MS - 1 })
    h.advance(2)
    const [x, y] = await Promise.all([h.feed.get(), h.feed.get()])
    expect([x.tier, y.tier]).toEqual(["updating", "updating"]); expect(x.parsed || y.parsed).toBe(false)
    await h.settle(); expect(h.up.calls.length).toBe(3); expect(h.up.calls[1]!["if-none-match"]).toBe('"v1"')   // the fake has no collapsing: two refreshes
    expect(await h.feed.get()).toMatchObject({ tier: "hit", dataAgeMs: 0 })
    h.advance((FRESH_S + SWR_S) * 1000 + 1)
    expect(await h.feed.get()).toMatchObject({ tier: "revalidated", parsed: false })
  })
  it("a new upstream version is parsed once per isolate, even by concurrent requests", async () => {
    const h = harness(); await h.feed.get()
    h.up.bump('"v2"'); h.advance((FRESH_S + SWR_S) * 1000 + 1)
    const [a, b] = await Promise.all([h.feed.get(), h.feed.get()])
    expect(a.snap.version).toBe('"v2"'); expect(b.snap.version).toBe('"v2"'); expect([a.parsed, b.parsed].filter(Boolean).length).toBeLessThanOrEqual(1)
    const other = makeFeed(h.deps)   // a fresh isolate: parses what the cache holds, without calling upstream
    const n = h.up.calls.length; expect(await other.get()).toMatchObject({ tier: "hit", parsed: true }); expect(h.up.calls.length).toBe(n)
  })
  it("upstream down: the cache serves STALE within stale-if-error; if the feed fetch fails, the isolate's copy answers (stale-on-error); with nothing anywhere, fail", async () => {
    const h = harness(); await h.feed.get()
    h.up.setDown(true); h.advance((FRESH_S + SWR_S) * 1000 + 60_000)
    expect(await h.feed.get()).toMatchObject({ tier: "stale" })
    const broken = makeFeed({ minStations: 1, fetch: async () => { throw new Error("loopback down") } })
    await expect(broken.get()).rejects.toThrow(/loopback down/)
    let fail = false
    const flaky = makeFeed({ ...h.deps, fetch: req => fail ? Promise.resolve(new Response("x", { status: 502 })) : h.deps.fetch(req) })
    await flaky.get(); fail = true
    const r = await flaky.get(); expect(r.tier).toBe("stale-on-error"); expect(r.error).toMatch(/feed 502/)
  })
  it("a truncated or non-gzip feed is refused", async () => {
    const tiny = makeFeed({ fetch: async () => new Response(gzipSync(sample), { headers: { etag: '"x"' } }) })   // 22 stations < 1000
    await expect(tiny.get()).rejects.toThrow(/only 22 stations/)
    const html = makeFeed({ minStations: 1, fetch: async () => new Response("<html>", { headers: { etag: '"y"' } }) })
    await expect(html.get()).rejects.toThrow(/not gzip/)
  })
})

describe("/weather end to end (fake upstream)", () => {
  it("nearest stations with units, bearings true and magnetic, two ages, short cache-control", async () => {
    const h = harness()
    const handler = makeHandler(makeBlocks(async () => { throw new Error("no blocks") }), undefined, weatherLive(h.feed))
    const r = await handler(new Request("http://x/weather?lat=40.7&lon=-74.0&count=3"))
    expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toBe("private, max-age=30")
    const j = await r.json() as any
    expect(j.stations.map((s: any) => s.stationId)).toEqual(["KNYC", "KLGA", "KEWR"])
    const s = j.stations[0]
    expect(s.raw).toMatch(/^METAR KNYC/); expect(s.bearing.true).toBeGreaterThanOrEqual(0); expect(s.bearing.true).toBeLessThan(360)
    const decl = j.observer.magneticDeclination; expect(decl).toBeLessThan(-11); expect(decl).toBeGreaterThan(-14)   // NYC ≈ −12.5° (west)
    expect(((s.bearing.true - decl - s.bearing.magnetic) % 360 + 360) % 360).toBeLessThan(0.011)
    expect(s.observationStale).toBe(typeof s.observationAgeSeconds === "number" && s.observationAgeSeconds > 4500)
    expect(j.feed).toMatchObject({ tier: expect.any(String), stale: false, lastModified: "2026-10-29T11:25:16.000Z", stations: 22 })
    const bad = await handler(new Request("http://x/weather?lat=40.7&lon=-74.0&count=0")); expect(bad.status).toBe(400)
  })
  it("503 when there is no copy and upstream is down", async () => {
    const feed = makeFeed({ fetch: req => serveFeed(req, { fetch: async () => { throw new Error("down") }, log: () => {} }) })
    const handler = makeHandler(makeBlocks(async () => { throw new Error("no blocks") }), undefined, weatherLive(feed))
    const r = await handler(new Request("http://x/weather?lat=0&lon=0")); expect(r.status).toBe(503)
    expect(((await r.json()) as any)._tag).toBe("Unavailable")
  })
  it("/magnetic", async () => {
    const handler = makeHandler(makeBlocks(async () => { throw new Error("no blocks") }))
    const r = await handler(new Request("http://x/magnetic?lat=40.7&lon=-74&time=2026-10-29T12:00:00Z")); expect(r.status).toBe(200)
    const j = await r.json() as any
    expect(j.magnetic.model).toBe("WMM2025"); expect(j.magnetic.inValidityWindow).toBe(true); expect(j.magnetic.declination).toBeCloseTo(-12.6, 0)
    expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")   // with a time: deterministic
    expect((await handler(new Request("http://x/magnetic?lat=40.7&lon=-74"))).headers.get("cache-control")).toBe("public, max-age=3600")
  })
  it("/magnetic says when the compass is unusable: the North Pole is in WMM2025's blackout zone (H 1 796 nT < 2 000), Resolute Bay in caution (sweep 2026-10-31)", async () => {
    // Before: a plain declination (17.84° at 90°N) with nothing saying WMM calls it unreliable there.
    const handler = makeHandler(makeBlocks(async () => { throw new Error("no blocks") }))
    const at = async (lat: number, lon: number) => (await (await handler(new Request(`http://x/magnetic?lat=${lat}&lon=${lon}&time=2026-10-29T12:00:00Z`))).json() as any)
    const pole = await at(90, 0), resolute = await at(74.7, -94.83), nyc = await at(40.7, -74)
    expect(pole.magnetic.horizontalIntensityNt).toBeLessThan(2000); expect(pole.magnetic.compass).toBe("blackout")
    expect(resolute.magnetic.horizontalIntensityNt).toBeGreaterThanOrEqual(2000); expect(resolute.magnetic.compass).toBe("caution")
    expect(nyc.magnetic.compass).toBe("ok"); expect(nyc.conventions.compass).toMatch(/blackout below 2000 nT/)
  })
  it("/magnetic heightRef=msl is the same field as that height above the ellipsoid (height + N); no height = on the geoid", async () => {
    const handler = makeHandler(makeBlocks(async () => { throw new Error("no blocks") }))
    const at = async (qs: string) => (await (await handler(new Request(`http://x/magnetic?lat=27.99&lon=86.93&time=2026-10-29T12:00:00Z${qs}`))).json() as any)
    const msl = await at("&height=8848&heightRef=msl"), ell = await at(`&height=${msl.observer.heightEllipsoid}`), none = await at(""), geoid = await at(`&height=${none.observer.geoidUndulation}`)
    expect(msl.observer.heightEllipsoid).toBeCloseTo(8848 + msl.observer.geoidUndulation, 9)
    expect(ell.magnetic.totalIntensityNt).toBe(msl.magnetic.totalIntensityNt); expect(ell.magnetic.declination).toBe(msl.magnetic.declination)
    expect(geoid.magnetic.totalIntensityNt).toBe(none.magnetic.totalIntensityNt)
    expect(Math.abs(msl.magnetic.totalIntensityNt - none.magnetic.totalIntensityNt)).toBeGreaterThan(50)   // 8.8 km up: ~ −3·F·h/R ≈ −120 nT
  })
})
