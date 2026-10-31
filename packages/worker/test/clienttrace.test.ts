// Client ↔ server trace correlation: traceparent → client.trace_id / client.span_id on the root span, x-ephem-trace echo,
// forwarded to the Api, never the raw header, never in request rows; both pages send it on every API fetch.
import { afterEach, describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { makeHandler } from "../src/app.ts"
import { REC, direct, makeBlocks } from "../src/blocks.ts"
import { setTracing, type Tracing } from "../src/trace.ts"
import { CLIENT_TRACE_JS, parseTraceparent, traceparentMeta } from "../src/clienttrace.ts"
import { forwardHeaders, forwards } from "../src/responses.ts"
import { page as homePage } from "../src/home.ts"
import { RUM_JS } from "../src/rum.ts"

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
  const TPRE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/
  const metaOf = (html: string) => /<meta name="traceparent" content="([^"]*)">/.exec(html)?.[1]
  it("a page document carries trace context: <meta name=traceparent> in the head, Server-Timing, x-ephem-trace, on the root span", async () => {
    for (const path of ["/"]) {
      const { spans, tracing } = recorder(); setTracing(tracing)
      const res = await makeHandler(makeBlocks(origin))(new Request("http://x" + path))
      const html = await res.text(), meta = metaOf(html)!, m = TPRE.exec(meta)!
      expect(m, path).not.toBeNull()
      expect(html.indexOf(meta)).toBeLessThan(html.indexOf("</head>"))
      expect(res.headers.get("x-ephem-trace"), path).toBe(m[1])
      expect(res.headers.get("server-timing"), path).toMatch(new RegExp(`^trace;desc="${meta}", total;dur=`))
      const root = spans.find(s => s.name === "GET")!.attrs
      expect(root, path).toMatchObject({ "client.trace_id": m[1], "client.document_span_id": m[2], "client.trace_origin": "minted", "effect.span_id": m[2] })   // fetches are children of the root span
      expect(res.headers.get("cache-control"), path).toBe("private, no-store")
      setTracing(undefined)
    }
  })
  it("an incoming traceparent on the document is adopted: same trace id, the incoming span is the parent", async () => {
    const { spans, tracing } = recorder(); setTracing(tracing)
    const res = await makeHandler(makeBlocks(origin))(new Request("http://x/", { headers: { traceparent: TP } }))
    const m = TPRE.exec(metaOf(await res.text())!)!
    expect(m[1]).toBe(TID); expect(m[2]).not.toBe(SID); expect(res.headers.get("x-ephem-trace")).toBe(TID)
    expect(spans.find(s => s.name === "GET")!.attrs).toMatchObject({ "client.trace_id": TID, "client.span_id": SID, "client.trace_origin": "adopted", "effect.parent_id": SID })
  })
  it("malformed traceparents on the document are ignored: a fresh id, nothing of the header in the page or spans", async () => {
    const bad = [`00-${TID.toUpperCase()}-${SID}-01`, `00-${"0".repeat(32)}-${SID}-01`, `00-${TID}-${"0".repeat(16)}-01`, `ff-${TID}-${SID}-01`, `00-${TID}-${SID}-01-extra`,
      `00-${TID}-${SID}-01"><script>alert(1)</script>`, "00-" + "g".repeat(32) + "-" + SID + "-01", " ".repeat(55)]
    for (const h of bad) {
      const { spans, tracing } = recorder(); setTracing(tracing)
      const res = await makeHandler(makeBlocks(origin))(new Request("http://x/", { headers: { traceparent: h } }))
      const html = await res.text(), m = TPRE.exec(metaOf(html)!)!
      expect(m, h).not.toBeNull(); expect(m[1], h).not.toBe(TID)
      expect(html).not.toContain("alert(1)")
      expect(spans.find(s => s.name === "GET")!.attrs["client.trace_origin"], h).toBe("minted")
      setTracing(undefined)
    }
  })
  it("no cached HTML can carry a stale trace id: pages are private, no-store, never forwarded to the cached Api, and every response gets a new id", async () => {
    expect(forwards("GET", new URL("http://x/"))).toBe(false);
    const h = makeHandler(makeBlocks(origin))
    for (const path of ["/"]) {
      const ids = new Set<string>()
      for (let i = 0; i < 5; i++) { const r = await h(new Request("http://x" + path)); expect(r.headers.get("cache-control")).toBe("private, no-store"); ids.add(metaOf(await r.text())!) }
      expect(ids.size, path).toBe(5)
    }
  })
  it("a synthetic document (x-ephem-load / x-ephem-smoke) says so to its RUM; a real one does not", async () => {
    const h = makeHandler(makeBlocks(origin))
    expect(await (await h(new Request("http://x/", { headers: { "x-ephem-load": "J1" } }))).text()).toContain('<meta name="ephem-synthetic" content="1">')
    expect(await (await h(new Request("http://x/", { headers: { "x-ephem-smoke": "s" } }))).text()).toContain('<meta name="ephem-synthetic" content="1">')
    expect(await (await h(new Request("http://x/"))).text()).not.toContain(`<meta name="ephem-synthetic"`)
  })
  it("traceparentMeta renders only a valid hex traceparent", () => {
    expect(traceparentMeta({ traceId: TID, spanId: SID, traceparent: TP })).toBe(`<meta name="traceparent" content="${TP}">`)
    expect(traceparentMeta({ traceId: TID, spanId: SID, traceparent: `00-${TID}-${SID}-01"><x>` })).toBe("")
    expect(traceparentMeta(undefined)).toBe("")
  })
  it("the page boot reads the meta tag first, then the navigation entry's serverTiming, then mints a fresh id", () => {
    const boot = (meta: string | null, st: string | null) => {
      const win: Record<string, unknown> = {}
      const document = { querySelector: () => meta == null ? null : { getAttribute: () => meta } }
      const performance = { now: () => 0, getEntriesByType: () => [{ serverTiming: st == null ? [] : [{ name: "total", description: "" }, { name: "trace", description: st }] }] }
      new Function("window", "document", "performance", "crypto", CLIENT_TRACE_JS)(win, document, performance, globalThis.crypto)
      return win.__ephemTrace as { traceId: string; parentSpanId: string | null; from: string }
    }
    const OTHER = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`
    expect(boot(TP, OTHER)).toMatchObject({ traceId: TID, parentSpanId: SID, from: "meta" })
    expect(boot(null, OTHER)).toMatchObject({ traceId: "a".repeat(32), parentSpanId: "b".repeat(16), from: "server-timing" })
    expect(boot("junk", null)).toMatchObject({ parentSpanId: null, from: "fresh" })
    expect(boot(`00-${"0".repeat(32)}-${SID}-01`, null).from).toBe("fresh")
    expect(boot(null, null).traceId).toMatch(/^[0-9a-f]{32}$/)
  })
  it("the front door forwards a valid traceparent to the Api, drops an invalid one", () => {
    expect(forwardHeaders({ "cf-ray": "r1-EWR", traceparent: TP })).toEqual({ "x-ephem-ray": "r1-EWR", traceparent: TP })
    expect(forwardHeaders({ "cf-ray": "r1-EWR", traceparent: "garbage" })).toEqual({ "x-ephem-ray": "r1-EWR" })
  })
  it("the page sends it on every API fetch (no bare fetch) and expose window.__ephemTrace", () => {
    for (const html of [homePage(V)]) {
      expect(html).toContain(CLIENT_TRACE_JS)
      expect(html.replace(RUM_JS, "").match(/\bfetch\(/g)?.length).toBe(1)   // the one inside __tfetch (RUM_JS posts to /rum)
      expect(html).toContain(RUM_JS)
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
