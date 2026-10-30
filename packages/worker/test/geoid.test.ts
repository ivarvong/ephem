// EGM96 bands from R2 through BlockStore (src/geoid.ts), with an injected band fetch: no network.
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { EGM96_BANDS, geoidBandsFor, geoidUndulation, setGeoidSource } from "@ephem/core"
import { bundledGeoidBand, bundledGeoidObject } from "../../core/src/geoid-bundled.ts"
import { makeHandler } from "../src/app.ts"
import { direct, makeBlocks } from "../src/blocks.ts"
import { GEOID_CACHE_CONTROL, geoidPath, loopbackGeoid, makeGeoid, r2GeoidOrigin, serveGeoid, verifyBand } from "../src/geoid.ts"
import { CACHE_TAG } from "../src/cache-version.ts"
import { makeLoopback } from "../src/loopback.ts"
import type { R2BucketLike } from "../src/blocks.ts"

const FIX = resolve(__dirname, "../../core/test/fixtures/blocks")
const blocks = () => makeBlocks(direct(async first => { const b = readFileSync(`${FIX}/${first}.bin`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer }))
const ab = (x: Uint8Array) => x.buffer.slice(x.byteOffset, x.byteOffset + x.byteLength) as ArrayBuffer
/** An R2 bucket holding only the geoid object; counts range reads. */
const fakeR2 = () => {
  const obj = bundledGeoidObject(), reads: Array<{ offset: number; length: number }> = []
  const bucket: R2BucketLike = {
    get: async (key, o) => {
      if (key !== EGM96_BANDS.key) return null
      const { offset, length } = o!.range!; reads.push({ offset, length })
      const s = obj.slice(offset, offset + length); return { size: s.length, arrayBuffer: async () => ab(s) }
    },
    head: async () => null, put: async () => undefined,
  }
  return { bucket, reads }
}
const NYC = "lat=40.7&lon=-74", T = "time=2026-10-28T12:00:00Z"

describe("geoid bands via BlockStore", () => {
  it("serveGeoid: one sha-checked band per path, immutable; bad paths 404, bad bytes 502 and never cached", async () => {
    const { bucket, reads } = fakeR2()
    expect(geoidPath(6)).toBe(`/geoid/${CACHE_TAG}/${EGM96_BANDS.sha256.slice(0, 16)}/6`)
    const r = await serveGeoid(new Request(`https://blocks.internal${geoidPath(6)}`), r2GeoidOrigin(bucket))
    expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toBe(GEOID_CACHE_CONTROL)
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(bundledGeoidBand(6))
    expect(reads).toEqual([{ offset: EGM96_BANDS.bands[6]![0], length: EGM96_BANDS.bands[6]![1] }])
    for (const p of [`/geoid/${CACHE_TAG}/0000000000000000/6`, geoidPath(46), `/geoid/v0/${EGM96_BANDS.sha256.slice(0, 16)}/6`])
      expect((await serveGeoid(new Request(`https://b${p}`), r2GeoidOrigin(bucket))).status).toBe(404)
    const bad = await serveGeoid(new Request(`https://b${geoidPath(6)}`), async () => ab(bundledGeoidBand(7)))
    expect(bad.status).toBe(502); expect(bad.headers.get("cache-control")).toBe("no-store"); expect(await bad.text()).toMatch(/band 6/)
  })
  it("two makeGeoid in one isolate (front door + Api): bands either one fetched are visible to core", async () => {
    setGeoidSource(bundledGeoidBand); const want = geoidUndulation(40.7, -74)
    const fetch = async (b: number) => ({ buf: ab(bundledGeoidBand(b)), status: "MISS" })
    const api = makeHandler(blocks(), undefined, undefined, makeGeoid(fetch))
    makeGeoid(fetch)   // the front door's, installed after the Api's (module order in index.ts): it used to hide the Api's L1
    const r = await api(new Request(`http://x/v1/position?${NYC}&${T}`))
    expect(r.status).toBe(200); expect((await r.json() as { observer: { geoidUndulation: number } }).observer.geoidUndulation).toBe(want)
  })
  it("the loopback asks BlockStore for the versioned path", async () => {
    const urls: string[] = []
    const lb = makeLoopback(() => ({ BlockStore: { fetch: async (req: Request) => { urls.push(new URL(req.url).pathname); return new Response("x") } } }))
    await lb.geoid(3); expect(urls).toEqual([geoidPath(3)])
  })
  it("a geoid route fetches only its band(s), concurrently with blocks; the isolate L1 answers next time; answers equal the bundled grid", async () => {
    setGeoidSource(bundledGeoidBand); const want = geoidUndulation(40.7, -74)   // the grid from the source tree
    const calls: number[] = []
    const geoid = makeGeoid(async b => { calls.push(b); return { buf: ab(bundledGeoidBand(b)), status: "MISS" } })
    const h = makeHandler(blocks(), undefined, undefined, geoid)
    const r1 = await (await h(new Request(`http://x/v1/position?${NYC}&${T}`))).json() as { observer: { geoidUndulation: number } }
    expect(calls).toEqual(geoidBandsFor(40.7))
    await h(new Request(`http://x/v1/day?${NYC}&date=2026-10-28&tz=America/New_York`))
    expect(calls).toEqual(geoidBandsFor(40.7))   // L1
    expect(r1.observer.geoidUndulation).toBe(want)
  })
  it("routes without an observer never touch the geoid; alignment loads only the bands its standing points can reach", async () => {
    const calls: number[] = []
    const h = makeHandler(blocks(), undefined, undefined, makeGeoid(async b => { calls.push(b); throw new Error("no") }))
    expect((await h(new Request("http://x/v1/magnetic?lat=40.7&lon=-74&time=2026-10-28T12:00:00Z"))).status).toBe(200)
    expect(calls).toEqual([])
    // alignment has heights (heightRef / targetHeightRef, and the eye on the geoid by default) since 2026-10-30
    const ok: number[] = []
    const h2 = makeHandler(blocks(), undefined, undefined, makeGeoid(async b => { ok.push(b); return { buf: ab(bundledGeoidBand(b)), status: "MISS" } }))
    const a = await h2(new Request("http://x/v1/alignment?body=moon&targetLat=40.68925&targetLon=-74.0445&targetHeight=63.4&start=2026-10-29T02:00:00Z&end=2026-10-29T02:10:00Z"))
    expect(a.status).toBe(200)
    expect([...new Set(ok)].toSorted()).toEqual([...new Set([...geoidBandsFor(40.68925 - 0.2), ...geoidBandsFor(40.68925 + 0.2)])].toSorted())
  })
  it("fails closed: a failed fetch or a band with the wrong bytes is a 503 GeoidUnavailable, and is retried next request", async () => {
    let n = 0
    const h = makeHandler(blocks(), undefined, undefined, makeGeoid(loopbackGeoid(async b => {
      n++; return n === 1 ? new Response("R2 down", { status: 502 }) : n === 2 ? new Response(ab(bundledGeoidBand(b + 1))) : new Response(ab(bundledGeoidBand(b)), { headers: { "cf-cache-status": "HIT" } })
    })))
    for (const want of [/BlockStore 502 for geoid band 12: R2 down/, /band 12: (\d+ bytes|sha256)/]) {
      const r = await h(new Request(`http://x/v1/track?${NYC}&start=2026-10-29T00:00:00Z&end=2026-10-29T01:00:00Z`))
      expect(r.status).toBe(503)
      const body = await r.json() as { _tag: string; message: string }
      expect(body._tag).toBe("GeoidUnavailable"); expect(body.message).toMatch(want)
      expect(r.headers.get("cache-control")).not.toMatch(/immutable/)
    }
    expect((await h(new Request(`http://x/v1/track?${NYC}&start=2026-10-29T00:00:00Z&end=2026-10-29T01:00:00Z`))).status).toBe(200)
  })
  it("concurrent cold requests share one fetch per band", async () => {
    let calls = 0
    const h = makeHandler(blocks(), undefined, undefined, makeGeoid(async b => { calls++; await new Promise(r => setTimeout(r, 5)); return { buf: ab(bundledGeoidBand(b)), status: "MISS" } }))
    const rs = await Promise.all([1, 2, 3, 4].map(m => h(new Request(`http://x/v1/position?lat=40.7&lon=-74.${m}&${T}`))))
    expect(rs.map(r => r.status)).toEqual([200, 200, 200, 200]); expect(calls).toBe(1)
  })
  it("verifyBand rejects wrong length and wrong content", async () => {
    await expect(verifyBand(6, ab(bundledGeoidBand(6)))).resolves.toEqual(bundledGeoidBand(6))
    await expect(verifyBand(6, ab(bundledGeoidBand(6).subarray(1)))).rejects.toThrow(/bytes, expected/)
    const x = Uint8Array.from(bundledGeoidBand(6)); x[100]! ^= 1
    await expect(verifyBand(6, ab(x))).rejects.toThrow(/sha256/)
    await expect(verifyBand(46, new ArrayBuffer(1))).rejects.toThrow(/no EGM96 band/)
  })
})
