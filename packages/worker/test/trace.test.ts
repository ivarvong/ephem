// The Effect → Workers tracing bridge: spans nest by effect.parent_id, carry work counts, and a broken tracer never fails a request.
import { afterEach, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { makeHandler } from "../src/app.ts"
import { REC, direct, makeBlocks } from "../src/blocks.ts"
import { setTracing, type Tracing } from "../src/trace.ts"

const FIX = resolve(__dirname, "../../core/test/fixtures/blocks")
const origin = direct(async (first: number, count: number) => {
  const out = new Uint8Array(count * REC)
  for (let k = 0; k < count; k++) out.set(readFileSync(`${FIX}/${first + k}.bin`), k * REC)
  return out.buffer
})
/** Mirrors workerd's Span: setStatus takes { code }, anything else throws a TypeError. */
const recorder = () => {
  const spans: Array<{ name: string; attrs: Record<string, unknown> }> = []
  const tracing: Tracing = { startSpan: name => { const attrs: Record<string, unknown> = {}; return {
    isTraced: true, setAttribute: (k, v) => { attrs[k] = v },
    setStatus: s => { if (typeof s !== "object") throw new TypeError("parameter 1 is not of type 'TracingSpanStatus'"); attrs.status = s.code },
    end: () => { spans.push({ name, attrs }) } } } }
  return { spans, tracing }
}
const DAY = "/v1/day?date=2026-10-28&tz=America/New_York&lat=40.6892&lon=-74.0445"
afterEach(() => setTracing(undefined))

describe("Workers tracing bridge", () => {
  it("every Effect span reaches the tracer, nested and annotated", async () => {
    const { spans, tracing } = recorder(); setTracing(tracing)
    const res = await makeHandler(makeBlocks(origin))(new Request("http://x" + DAY))
    expect(res.status).toBe(200)
    const by = Object.fromEntries(spans.map(s => [s.name, s.attrs]))
    expect(Object.keys(by).toSorted()).toEqual(["GET", "blocks.load", "compute.day", "day", "geoid.load"])
    expect(by["geoid.load"]).toMatchObject({ "geoid.bands": 1, "ephem.geoid_cache": "L1", "effect.parent_id": by.day!["effect.span_id"] })
    expect(by["compute.day"]!["effect.parent_id"]).toBe(by.day!["effect.span_id"])
    expect(by.day!["effect.parent_id"]).toBe(by.GET!["effect.span_id"])
    expect(by["compute.day"]!["ephem.block_reads"]).toBeGreaterThan(0)
    expect(by["blocks.load"]).toMatchObject({ "cache.blocks_origin": 1, "ephem.blocks_cache": "ORIGIN:1", status: "ok" })
  })
  it("a tracer that throws on every call does not fail the request", async () => {
    setTracing({ startSpan: () => { throw new Error("boom") } })
    expect((await makeHandler(makeBlocks(origin))(new Request("http://x" + DAY))).status).toBe(200)
    const bad = { isTraced: true, setAttribute: () => { throw new Error("a") }, setStatus: () => { throw new Error("s") }, end: () => { throw new Error("e") } }
    setTracing({ startSpan: () => bad })
    expect((await makeHandler(makeBlocks(origin))(new Request("http://x" + DAY))).status).toBe(200)
  })
})
