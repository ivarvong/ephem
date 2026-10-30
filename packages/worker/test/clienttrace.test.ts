// Client ↔ server trace correlation: traceparent → client.trace_id / client.span_id on the root span, x-ephem-trace echo,
// forwarded to the Api, never the raw header, never in request rows; both pages send it on every API fetch.
import { afterEach, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { makeHandler } from "../src/app.ts"
import { REC, direct, makeBlocks } from "../src/blocks.ts"
import { setTracing, type Tracing } from "../src/trace.ts"
import { CLIENT_TRACE_JS, parseTraceparent } from "../src/clienttrace.ts"
import { forwardHeaders } from "../src/responses.ts"
import { page as homePage } from "../src/home.ts"
import { instrumentPage } from "../src/instrument.ts"

const FIX = resolve(__dirname, "../../core/test/fixtures/blocks")
const origin = direct(async (first: number, count: number) => {
  const out = new Uint8Array(count * REC)
  for (let k = 0; k < count; k++) out.set(readFileSync(`${FIX}/${first + k}.bin`), k * REC)
  return out.buffer
})
const recorder = () => {
  const spans: Array<{ name: string; attrs: Record<string, unknown> }> = []
  const tracing: Tracing = { startSpan: name => { const attrs: Record<string, unknown> = {}; return {
    isTraced: true, setAttribute: (k, v) => { attrs[k] = v }, setStatus: s => { attrs.status = s.code }, end: () => { spans.push({ name, attrs }) } } } }
  return { spans, tracing }
}
afterEach(() => setTracing(undefined))
const TID = "4bf92f3577b34da6a3ce929d0e0e4736", SID = "00f067aa0ba902b7", TP = `00-${TID}-${SID}-01`
const DAY = "/v1/day?date=2026-10-28&tz=America/New_York&lat=40.6892&lon=-74.0445"
const V = { lat: 40.7128, lon: -74.006, place: "New York", city: "New York", tz: "America/New_York", colo: null, source: "query" } as const

describe("traceparent", () => {
  it("parses version 00 only, lower-case hex, non-zero ids", () => {
    expect(parseTraceparent(TP)).toEqual({ traceId: TID, spanId: SID })
    for (const bad of [undefined, "", TP.toUpperCase(), `01-${TID}-${SID}-01`, `00-${"0".repeat(32)}-${SID}-01`, `00-${TID}-${"0".repeat(16)}-01`,
      `00-${TID}-${SID}-01-x`, `00-${TID}-${SID}`, `00-${TID}-${SID}-0g`]) expect(parseTraceparent(bad), String(bad)).toBeUndefined()
  })
  it("the root span gets client.trace_id / client.span_id, the response echoes the trace id; nothing else of the header", async () => {
    const { spans, tracing } = recorder(); setTracing(tracing)
    const res = await makeHandler(makeBlocks(origin))(new Request("http://x" + DAY, { headers: { traceparent: TP, tracestate: "vendor=secret" } }))
    expect(res.status).toBe(200)
    expect(res.headers.get("x-ephem-trace")).toBe(TID)
    const root = spans.find(s => s.name === "GET")!.attrs
    expect(root).toMatchObject({ "client.trace_id": TID, "client.span_id": SID })
    expect(root["effect.parent_id"]).toBe(SID)   // Effect's HttpMiddleware.tracer parents the request span on it
    const all = JSON.stringify(spans)
    expect(all).not.toContain("vendor=secret"); expect(all).not.toContain(TP)
  })
  it("a malformed traceparent is ignored: no attributes, no echo", async () => {
    const { spans, tracing } = recorder(); setTracing(tracing)
    const res = await makeHandler(makeBlocks(origin))(new Request("http://x" + DAY, { headers: { traceparent: "00-nope" } }))
    expect(res.status).toBe(200); expect(res.headers.get("x-ephem-trace")).toBeNull()
    expect(JSON.stringify(spans)).not.toContain("client.trace_id")
  })
  it("the front door forwards a valid traceparent to the Api, drops an invalid one", () => {
    expect(forwardHeaders({ "cf-ray": "r1-EWR", traceparent: TP })).toEqual({ "x-ephem-ray": "r1-EWR", traceparent: TP })
    expect(forwardHeaders({ "cf-ray": "r1-EWR", traceparent: "garbage" })).toEqual({ "x-ephem-ray": "r1-EWR" })
  })
  it("both pages send it on every API fetch (no bare fetch) and expose window.__ephemTrace", () => {
    for (const html of [homePage(V), instrumentPage(V)]) {
      expect(html).toContain(CLIENT_TRACE_JS)
      expect(html.match(/\bfetch\(/g)?.length).toBe(1)   // the one inside __tfetch
      expect(html).toContain('performance.mark("ephem:data")')
    }
  })
  it("the browser snippet makes one trace id per load and a fresh span id per fetch", async () => {
    const seen: Array<Headers> = []
    const win: Record<string, unknown> = {}
    const run = new Function("window", "fetch", "performance", "crypto", "Headers", CLIENT_TRACE_JS + "; return __tfetch;")
    const tf = run(win, async (_u: string, i: { headers: Headers }) => { seen.push(i.headers); return new Response("{}", { headers: { "cf-ray": "abc-EWR", "x-ephem-trace": "t" } }) },
      { now: () => 1 }, globalThis.crypto, Headers) as (u: string) => Promise<Response>
    await tf("/v1/a"); await tf("/v1/b")
    const ids = seen.map(h => parseTraceparent(h.get("traceparent")))
    expect(ids[0]!.traceId).toBe(ids[1]!.traceId); expect(ids[0]!.spanId).not.toBe(ids[1]!.spanId)
    const T = win.__ephemTrace as { traceId: string; fetches: Array<{ ray: string; status: number }> }
    expect(T.traceId).toBe(ids[0]!.traceId); expect(T.fetches.map(f => f.ray)).toEqual(["abc-EWR", "abc-EWR"])
  })
})
