import { describe, expect, it } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import { createHash } from "node:crypto"
import { makeHandler } from "../src/app.ts"
import { BLOCK_CACHE_CONTROL, REC, R2_KEY, blockOffset, blockPath, blocksCache, direct, loopbackBlocks, makeBlocks, r2Origin, serveBlock, type R2BucketLike } from "../src/blocks.ts"
import { checkHeader, ingest, parseHeader, status } from "../src/ingest.ts"
import { DE440 } from "@ephem/core"

const FIX = resolve(__dirname, "../../core/test/fixtures")
const fixtureBlock = (i: number) => { const b = readFileSync(`${FIX}/blocks/${i}.bin`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer }

/** In-memory R2 over the fixture blocks: a sparse view of the 102 MB object, with read accounting. */
const fakeR2 = () => {
  const log: Array<{ offset: number; length: number }> = []
  const bucket: R2BucketLike = {
    async get(key, opts) {
      if (key !== R2_KEY || !opts?.range) return null
      const { offset, length } = opts.range; log.push({ offset, length })
      const out = new Uint8Array(length)
      for (let o = 0; o < length; o += REC) out.set(new Uint8Array(fixtureBlock((offset + o) / REC - 2)), o)
      return { size: DE440.sizeBytes, arrayBuffer: async () => out.buffer }
    },
    async head() { return { size: DE440.sizeBytes, customMetadata: { sha256: DE440.sha256 } } },
    async put() { throw new Error("read-only") },
  }
  return { bucket, log }
}
/** A fake Workers Caching in front of serveBlock (the BlockStore entrypoint): stores 200s that say immutable, reports cf-cache-status. */
const fakeCachedStore = (bucket: R2BucketLike) => {
  const store = new Map<string, ArrayBuffer>(); let runs = 0
  const fetch = async (req: Request) => {
    const k = new URL(req.url).pathname, hit = store.get(k)
    if (hit) return new Response(hit.slice(0), { headers: { "cf-cache-status": "HIT" } })
    runs++; const r = await serveBlock(req, r2Origin(bucket)); const body = await r.arrayBuffer()
    if (r.status === 200 && /immutable/.test(r.headers.get("cache-control") ?? "")) store.set(k, body)
    return new Response(body, { status: r.status, headers: { ...Object.fromEntries(r.headers), "cf-cache-status": "MISS" } })
  }
  return { fetch, store, runs: () => runs }
}

describe("block loading", () => {
  it("cold: one exact R2 range per block through BlockStore (MISS); L1 next; after eviction a cache HIT, never re-read from R2", async () => {
    const { bucket, log } = fakeR2(), cached = fakeCachedStore(bucket)
    const handler = makeHandler(makeBlocks(loopbackBlocks(i => cached.fetch(new Request(`https://blocks.internal${blockPath(i)}`))), 1))
    const get = async (p: string) => (await (await handler(new Request("http://x" + p))).json()) as any
    const q = "/position?lat=40.7127&lon=-74.0059&height=-22.6&time=2026-10-28T11:51:00Z"
    const a = await get(q)
    expect(a.provenance.diagnostics.cache).toMatchObject({ l1: 0, blocks_miss: 1, fetchedBytes: REC })
    expect(log).toEqual([{ offset: blockOffset(5442), length: REC }])
    const b = await get(q); expect(b.provenance.diagnostics.cache).toMatchObject({ l1: 1, fetchedBytes: 0 }); expect(b.provenance.diagnostics.cache.blocks_miss).toBeUndefined()
    await get("/position?lat=0&lon=0&time=1997-08-16T01:52:34Z")             // evicts 5442 from a 1-entry L1
    const c = await get(q); expect(c.provenance.diagnostics.cache).toMatchObject({ l1: 0, blocks_hit: 1, fetchedBytes: REC })
    expect(log.length).toBe(2); expect(cached.runs()).toBe(2)                      // 5442 and the 1997 block, once each
    expect(blocksCache({ l1: 1, blocks_hit: 2, blocks_miss: 1, fetchedBytes: 3 })).toBe("HIT:2,MISS:1"); expect(blocksCache({ l1: 2, fetchedBytes: 0 })).toBe("L1")
  })
  it("concurrent loads of the same block in one isolate fetch it once", async () => {
    const { bucket } = fakeR2(); let calls = 0
    const load = makeBlocks(async i => { calls++; await new Promise(r => setTimeout(r, 5)); return { buf: await r2Origin(bucket)(i, 1), status: "MISS" } })
    const { Effect } = await import("effect"); const { Blocks } = await import("../src/blocks.ts")
    const one = Effect.gen(function* () { const s = yield* Blocks; return yield* s.load([5441, 5442]) }).pipe(Effect.provide(load))
    const [x, y] = await Promise.all([Effect.runPromise(one), Effect.runPromise(one)])
    expect(calls).toBe(2); expect((x.stats.blocks_miss ?? 0) + (y.stats.blocks_miss ?? 0)).toBe(2); expect(x.stats.l1! + y.stats.l1!).toBe(2)
  })
  it("BlockStore: immutable 200 for a real block; 404 / 405 / 502 are no-store", async () => {
    const { bucket } = fakeR2()
    const ok = await serveBlock(new Request("https://b" + blockPath(5442)), r2Origin(bucket))
    expect(ok.status).toBe(200); expect(ok.headers.get("cache-control")).toBe(BLOCK_CACHE_CONTROL); expect((await ok.arrayBuffer()).byteLength).toBe(REC)
    for (const [req, st] of [[new Request("https://b/block/0000000000000000/5442"), 404], [new Request("https://b" + blockPath(99_999_999)), 404],
      [new Request("https://b" + blockPath(5442), { method: "POST", body: "x" }), 405]] as const) {
      const r = await serveBlock(req, r2Origin(bucket)); expect(r.status).toBe(st); expect(r.headers.get("cache-control")).toBe("no-store")
    }
    const wrong = await serveBlock(new Request("https://b" + blockPath(5442)), async (first, count) => r2Origin(bucket)(first - 1, count))
    expect(wrong.status).toBe(502); expect(wrong.headers.get("cache-control")).toBe("no-store")
  })
  it("rejects a block whose bytes are not the block asked for", async () => {
    const { bucket } = fakeR2()
    const wrong = makeBlocks(direct(async (first, count) => (await r2Origin(bucket)(first - 1, count))))   // off-by-one origin (5441 served for 5442)
    const h = makeHandler(wrong)
    const r = await h(new Request("http://x/position?lat=0&lon=0&time=2026-10-28T11:51:00Z"))
    expect(r.status).toBe(500)
  })
})

describe("worker handler", () => {
  const handler = makeHandler(makeBlocks(direct(r2Origin(fakeR2().bucket))))
  const get = async (p: string) => { const r = await handler(new Request("http://x" + p)); return { status: r.status, headers: r.headers, body: await r.json() as any } }
  it("errors are one shape: 400 InvalidRequest naming the parameter and what is allowed", async () => {
    const s = await get("/position?lat=91&lon=0&time=2026-10-28T11:51:00Z"); expect(s.status).toBe(400); expect(s.body).toMatchObject({ _tag: "InvalidRequest", parameter: "lat" }); expect(s.body.message).toMatch(/lat=91 .*−90 to 90/)
    const r = await get("/position?lat=0&lon=0&time=1960-01-01T00:00:00Z"); expect(r.status).toBe(400); expect(r.body).toMatchObject({ _tag: "InvalidRequest", parameter: "time" }); expect(r.body.message).toMatch(/1972-01-01T00:00:00Z to 2149/)
    const d = await get("/day?lat=0&lon=0&date=2026-10-28&tz=Mars/Olympus"); expect(d.status).toBe(400); expect(d.body).toMatchObject({ _tag: "InvalidRequest", parameter: "tz" })
    const c = await get("/crossing?lat=0&lon=0&body=venus&altitude=0&date=2026-10-28&tz=UTC"); expect(c.body).toMatchObject({ parameter: "body", allowed: ["sun", "moon"] })
    const m = await get("/position?lon=0"); expect(m.body.message).toMatch(/^missing required parameter lat: /)
    expect((await get("/alignment?body=moon&targetLat=40.68925&targetLon=-74.0445&targetHeight=63.4&start=2026-10-29T02:00:00Z&end=2026-10-28T23:45:00Z")).status).toBe(400)
  })
  it("a date that is not on the calendar, or that the zone skipped, is a 400, not another day's answer (sweep 2026-10-31)", async () => {
    // Before: 2026-02-30 answered for 2026-03-02 under the label 2026-02-30; Pacific/Apia's skipped 2011-12-30 was a 200 with an empty day.
    for (const [date, tz, re] of [["2026-02-30", "America/New_York", /not a calendar date/], ["2026-13-01", "UTC", /not a calendar date/], ["2026-04-31", "UTC", /not a calendar date/],
      ["2011-12-30", "Pacific/Apia", /does not exist in Pacific\/Apia/]] as const) {
      const d = await get(`/day?lat=-13.8&lon=-171.8&date=${date}&tz=${tz}`)
      expect(d.status, `${date} ${tz}`).toBe(400); expect(d.body).toMatchObject({ _tag: "InvalidRequest", parameter: "date" }); expect(d.body.message).toMatch(re)
      const c = await get(`/crossing?lat=-13.8&lon=-171.8&body=sun&altitude=0&date=${date}&tz=${tz}`)
      expect(c.status, `crossing ${date} ${tz}`).toBe(400); expect(c.body).toMatchObject({ _tag: "InvalidRequest", parameter: "date" })
    }
  })
  it("position without time is the sky now", async () => {
    const before = Date.now(), r = await get("/position?lat=40.7&lon=-74"), after = Date.now()
    expect(r.status).toBe(200)
    const t = Date.parse(r.body.time.utc); expect(t).toBeGreaterThanOrEqual(before - 1); expect(t).toBeLessThanOrEqual(after + 1)
  })
  it("unknown query parameters are a 400 naming them and the allowed set, on every endpoint (2026-10-29: they were silently ignored)", async () => {
    const d = await get("/day?lat=40.7&lon=-74&date=2026-10-28&tz=America/New_York&temprature=-20")
    expect(d.status).toBe(400); expect(d.body).toMatchObject({ _tag: "InvalidRequest", parameter: "temprature" }); expect(d.body.message).toMatch(/did you mean temperature\?/)
    expect((await get("/weather?lat=1&lon=2&n=3")).body.message).toMatch(/n: did you mean count\?/)   // renamed 2026-10-31
    expect(d.body.allowed).toContain("temperature"); expect(d.body.message).toMatch(/temprature.*allowed: lat, lon/)
    for (const p of ["/position?lat=1&lon=2", "/crossing?lat=1&lon=2&body=sun&altitude=0&date=2026-10-28&tz=UTC", "/alignment?body=sun&targetLat=1&targetLon=2&targetHeight=0&start=2026-10-28T00:00:00Z&end=2026-10-28T01:00:00Z", "/magnetic?lat=1&lon=2"])
      expect((await get(p + "&x=1")).status, p).toBe(400)
    // the old silent case: temperature/pressure on /day are now real parameters and move sunrise
    const a = await get("/day?lat=40.7&lon=-74&date=2026-10-28&tz=America/New_York"), b = await get("/day?lat=40.7&lon=-74&date=2026-10-28&tz=America/New_York&temperature=-20&pressure=1040")
    const rise = (r: any) => Date.parse(r.body.events.find((e: any) => e.kind === "rise" && e.body === "sun").time)
    expect(rise(a) - rise(b)).toBeGreaterThan(5_000)   // colder, denser air: more refraction, earlier sunrise
  })
  it("day and alignment round-trip through the contract; headers present", async () => {
    const d = await get("/day?lat=40.7127&lon=-74.0059&height=-22.6&date=2026-10-28&tz=America/New_York"); expect(d.status).toBe(200)
    // height −22.6 m above the ellipsoid is ≈ +10 m above sea level here (EGM96 N ≈ −32.6 m): the sea horizon dips ≈ 5.7′, so the Sun
    // rises ≈ 39 s before the sea-level answer, which is the pre-2026-10-29 value (height was ignored for rise/set) and is still what
    // heightRef=msl&height=0 gives.
    expect(d.body.events.find((e: any) => e.kind === "rise" && e.body === "sun").time).toBe("2026-10-28T11:21:04.962Z")
    const sea = await get("/day?lat=40.7127&lon=-74.0059&height=0&heightRef=msl&date=2026-10-28&tz=America/New_York")
    expect(sea.body.events.find((e: any) => e.kind === "rise" && e.body === "sun").time).toBe("2026-10-28T11:21:43.461Z")
    expect(d.headers.get("server-timing")).toMatch(/total;dur=/); expect(d.headers.get("access-control-allow-origin")).toBe("*")
    const a = await get("/alignment?body=moon&targetLat=40.68925&targetLon=-74.0445&targetHeight=63.4&height=-30.9&start=2026-10-28T23:45:00Z&end=2026-10-29T02:00:00Z&stepSeconds=1800&maxDistanceKm=20&lat=40.6892&lon=-74.0760")
    expect(a.status).toBe(200); expect(a.body.track.length).toBe(5); expect(a.body.track[0]).not.toHaveProperty("iterations")
  })
  it("track: one answer for the whole grid, each sample bit-identical to /position at that instant", async () => {
    const t = await get("/track?lat=40.7127&lon=-74.0059&height=-22.6&start=2026-10-28T00:00:00Z&end=2026-10-30T00:00:00Z")
    expect(t.status).toBe(200); expect(t.body).toMatchObject({ start: "2026-10-28T00:00:00.000Z", end: "2026-10-30T00:00:00.000Z", stepSeconds: 1200, count: 145 })
    for (const b of ["sun", "moon"]) for (const f of ["azimuth", "altitude", "apparentAltitude"]) expect(t.body[b][f].length).toBe(145)
    expect(t.body.sun.apparentAltitude).toContain(null)   // night: below the sea horizon
    for (const i of [0, 31, 72, 144]) {
      const p = await get(`/position?lat=40.7127&lon=-74.0059&height=-22.6&time=${new Date(Date.parse(t.body.start) + i * 1200e3).toISOString()}`)
      for (const b of ["sun", "moon"]) for (const f of ["azimuth", "altitude", "apparentAltitude"]) expect(t.body[b][f][i], `${b}.${f}[${i}]`).toBe(p.body[b][f])
    }
    expect(t.body.observer).toEqual((await get("/position?lat=40.7127&lon=-74.0059&height=-22.6&time=2026-10-28T00:00:00Z")).body.observer)
    expect(t.body.provenance.diagnostics.blocks.length).toBeGreaterThan(0)
  })
  it("track = /position with every refraction and height parameter too: msl, T/P, horizon (geometric, degrees), dut1 (sweep 2026-10-31)", async () => {
    for (const extra of ["&height=320&heightRef=msl&temperature=-20&pressure=1040", "&horizon=geometric&dut1=0.31", "&height=1500&heightRef=msl&horizon=-1.2&temperature=30&pressure=850"]) {
      const t = await get(`/track?lat=69.6492&lon=18.9553&start=2026-10-28T00:00:00Z&end=2026-10-29T00:00:00Z&stepSeconds=600${extra}`)
      expect(t.status, extra).toBe(200)
      for (const i of [0, 50, 100, 144]) {
        const p = await get(`/position?lat=69.6492&lon=18.9553&time=${new Date(Date.parse(t.body.start) + i * 600e3).toISOString()}${extra}`)
        for (const b of ["sun", "moon"]) for (const f of ["azimuth", "altitude", "apparentAltitude"]) expect(t.body[b][f][i], `${extra} ${b}.${f}[${i}]`).toBe(p.body[b][f])
      }
      expect(t.body.conventions.horizon).toEqual((await get(`/position?lat=69.6492&lon=18.9553&time=2026-10-28T00:00:00Z${extra}`)).body.conventions.horizon)
    }
  })
  it("track is bounded and grid-aligned (stable cache keys, no CPU bombs)", async () => {
    const base = "/track?lat=40.7&lon=-74"
    const off = await get(`${base}&start=2026-10-28T00:10:00Z&end=2026-10-28T06:00:00Z`)   // not on the 20 min grid
    expect(off.status).toBe(400); expect(off.body.message).toMatch(/start=2026-10-28T00:00:00Z, end=2026-10-28T06:00:00Z/)
    expect((await get(`${base}&start=2026-10-28T00:00:00Z&end=2026-10-27T00:00:00Z`)).status).toBe(400)                     // end before start
    expect((await get(`${base}&start=2026-10-20T00:00:00Z&end=2026-10-29T00:00:00Z`)).body.message).toMatch(/at most 8 days/)
    expect((await get(`${base}&start=2026-10-28T00:00:00Z&end=2026-10-29T00:01:00Z&stepSeconds=60`)).body.message).toMatch(/1442 samples; at most 1441 per request/)
    expect((await get(`${base}&start=2026-10-28T00:00:00Z&end=2026-10-29T00:00:00Z&stepSeconds=60`)).body.count).toBe(1441)    // the bound itself is fine
    expect((await get(`${base}&start=2026-10-28T00:00:00Z&end=2026-10-28T01:00:00Z&stepSeconds=59`)).status).toBe(400)
    expect((await get(`${base}&start=1960-01-01T00:00:00Z&end=1960-01-02T00:00:00Z`)).status).toBe(400)
    expect((await get(`${base}&start=2026-10-28T00:00:00Z&end=2026-10-28T01:00:00Z&time=x`)).status).toBe(400)                // unknown parameter
  })
  it("serves OpenAPI and docs", async () => {
    expect((await get("/openapi.json")).body.paths["/alignment"]).toBeDefined()
    expect((await get("/openapi.json")).body.paths["/track"]).toBeDefined()
    const docs = await handler(new Request("http://x/docs")); expect(docs.status).toBe(200); expect(docs.headers.get("content-type")).toMatch(/html/); expect(await docs.text()).toContain("/openapi.json")
  })
})

describe("ingest", () => {
  it("parses the real DE440 header and it matches core's constants", () => {
    const b = readFileSync(`${FIX}/de440-header.bin`); const h = parseHeader(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
    expect(h).toMatchObject({ numde: 440, jdStart: DE440.jdStart, jdEnd: DE440.jdEnd, blockDays: 32, au: DE440.au, emrat: DE440.emrat })
    expect(() => checkHeader(h)).not.toThrow()
    expect(() => checkHeader({ ...h, emrat: 81.3 })).toThrow(/au\/emrat/)
  })

  // A writable fake R2 that enforces the sha256 put option exactly as R2 does.
  const writableR2 = () => {
    let obj: { bytes: Uint8Array; meta: Record<string, string> } | undefined; let puts = 0
    const bucket: R2BucketLike = {
      async head() { return obj ? { size: obj.bytes.length, customMetadata: obj.meta } : null },
      async get(_k, o) { if (!obj) return null; const r = o?.range ?? { offset: 0, length: obj.bytes.length }; const s = obj.bytes.slice(r.offset, r.offset + r.length); return { size: obj.bytes.length, arrayBuffer: async () => s.buffer } },
      async put(_k, value, o) {
        puts++
        const bytes = new Uint8Array(value instanceof ArrayBuffer ? value : await new Response(value).arrayBuffer())
        if (o?.sha256 && createHash("sha256").update(bytes).digest("hex") !== o.sha256) throw new Error("put: The SHA-256 checksum you specified did not match what we received.")
        obj = { bytes, meta: o?.customMetadata ?? {} }
      },
    }
    return { bucket, puts: () => puts }
  }
  const LOCAL = resolve(__dirname, "../../../data/jpl", DE440.file)
  const jplFrom = (bytes: Uint8Array) => async () => new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]).stream(), { headers: { "content-length": String(bytes.length) } })

  it.skipIf(!existsSync(LOCAL))("streams JPL's file into R2, verifies it, and is idempotent", async () => {
    const file = new Uint8Array(readFileSync(LOCAL)), { bucket, puts } = writableR2()
    const deps = { bucket, fetch: jplFrom(file), fixedLength: (s: ReadableStream<Uint8Array>) => s }
    const r = await ingest(deps)
    expect(r.status).toBe("ingested"); expect(r.verified.firstBlockJd).toBe(DE440.jdStart); expect(r.verified.lastBlockJd).toBe(DE440.jdEnd - 32)
    expect(await status(bucket)).toMatchObject({ present: true, matchesPinned: true, sizeBytes: DE440.sizeBytes })
    expect((await ingest(deps)).status).toBe("already-present"); expect(puts()).toBe(1)
  }, 120_000)

  it.skipIf(!existsSync(LOCAL))("refuses a corrupted download (R2 rejects the checksum) and leaves nothing behind", async () => {
    const file = new Uint8Array(readFileSync(LOCAL)); file[5_000_000]! ^= 0xff
    const { bucket } = writableR2()
    await expect(ingest({ bucket, fetch: jplFrom(file), fixedLength: s => s })).rejects.toThrow(/SHA-256/)
    expect(await status(bucket)).toMatchObject({ present: false })
  }, 120_000)

  it("refuses a response of the wrong length before writing", async () => {
    const { bucket, puts } = writableR2()
    await expect(ingest({ bucket, fetch: jplFrom(new Uint8Array(10)), fixedLength: s => s })).rejects.toThrow(/content-length/)
    expect(puts()).toBe(0)
  })
})
