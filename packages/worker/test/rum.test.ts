// Production RUM (POST /rum → ephem_rum), the rich Server-Timing, request rows with trace ids and loopback trace propagation.
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { makeHandler } from "../src/app.ts"
import { REC, direct, makeBlocks } from "../src/blocks.ts"
import { RUM_JS, RUM_LIMITS, makeLimiter, targetOf, validateRum, type RumRow, type RumSinkI } from "../src/rum.ts"
import { buildRow, type RequestLogSink, type RequestRow } from "../src/requestlog.ts"
import { makeLoopback } from "../src/loopback.ts"

const FIX = resolve(__dirname, "../../core/test/fixtures/blocks")
const origin = direct(async (first: number, count: number) => {
  const out = new Uint8Array(count * REC)
  for (let k = 0; k < count; k++) out.set(readFileSync(`${FIX}/${first + k}.bin`), k * REC)
  return out.buffer
})
const TID = "4bf92f3577b34da6a3ce929d0e0e4736", SID = "00f067aa0ba902b7", TP = `00-${TID}-${SID}-01`
const ctx = (h: Record<string, string> = {}) => ({ now: Date.parse("2026-10-30T12:00:00Z"), headers: { "user-agent": "Mozilla/5.0 (Macintosh) Chrome/156", ...h }, cf: { colo: "EWR", country: "US", city: "New York" }, version: "v1" })
const span = (o: Record<string, unknown> = {}) => ({ k: "resource", n: "fetch", sid: "a1b2c3d4e5f60718", t: 12.3, d: 40, tg: "/v1/position", ph: [0, 0, 0, 30, 35, 5], b: 900, st: 200, pr: "h2", sv: 'api;desc="HIT";dur=3.1, total;dur=4', r: "a52e17c7ca334350-EWR", ...o })
const batch = (s: unknown[], o: Record<string, unknown> = {}) => ({ tp: TP, page: "/", seq: 0, to: Date.parse("2026-10-30T11:59:50Z"), vw: 390, dpr: 3, s, ...o })
const SCHEMA = JSON.parse(readFileSync(resolve(__dirname, "../ops/basin/rum.schema.json"), "utf8")) as Array<{ name: string; type: string; required: boolean }>
const matches = (row: Record<string, unknown>) => {
  for (const f of SCHEMA) { if (f.required) expect(row, f.name).toHaveProperty(f.name) }
  for (const k of Object.keys(row)) expect(SCHEMA.some(f => f.name === k), k).toBe(true)
}

describe("/rum validation (pure)", () => {
  it("a good batch → one row per span, keyed by trace + span id, route ids only, schema-shaped", () => {
    const r = validateRum(batch([span(), span({ k: "app", n: "data-ready", sid: "1111111111111111", tg: undefined, d: undefined })]), ctx())
    expect(r.ok).toBe(true); if (!r.ok) return
    expect(r.rows).toHaveLength(2); expect(r.dropped).toBe(0)
    expect(r.rows[0]).toMatchObject({ trace_id: TID, span_id: "a1b2c3d4e5f60718", parent_id: SID, kind: "resource", name: "fetch", page: "/", target: "/v1/position",
      cache: "HIT", ray: "a52e17c7ca334350-EWR", ttfb_ms: 35, ua_family: "browser", colo: "EWR", country: "US", synthetic: false, time_origin: "2026-10-30T11:59:50.000Z" })
    expect(r.rows[1]).toMatchObject({ kind: "app", name: "data-ready" })
    for (const row of r.rows) matches(row as unknown as Record<string, unknown>)
  })
  it("privacy: no IP, no user agent, no city, no URL or query is ever stored", () => {
    const r = validateRum(batch([span({ tg: "/v1/position?lat=40.71234&lon=-74.01", dt: "x" }), span({ tg: "https://evil.example/p?q=secret" }), span({ tg: "/fonts/7c1a2e7bc735/RPNDot-Regular.woff2" }), span({ tg: "/assets/000000000000/secret.txt" })]),
      ctx({ "cf-connecting-ip": "203.0.113.9", "x-real-ip": "203.0.113.9" }))
    if (!r.ok) throw new Error(r.reason)
    expect(r.rows.map(x => x.target)).toEqual(["other", "other", "other", "other"])
    const all = JSON.stringify(r.rows)
    for (const bad of ["203.0.113", "Mozilla", "Macintosh", "New York", "lat=", "evil", "secret", "?"]) expect(all, bad).not.toContain(bad)
  })
  it("DNT or GPC → nothing stored; an unsampled traceparent → nothing stored", () => {
    for (const h of [{ dnt: "1" }, { "sec-gpc": "1" }]) expect(validateRum(batch([span()]), ctx(h))).toEqual({ ok: true, rows: [], dropped: 0 })
    expect(validateRum(batch([span()], { tp: `00-${TID}-${SID}-00` }), ctx())).toEqual({ ok: true, rows: [], dropped: 0 })
  })
  it("synthetic traffic is flagged: x-ephem-load, x-ephem-smoke, navigator.webdriver", () => {
    for (const [h, o] of [[{ "x-ephem-load": "J1" }, {}], [{ "x-ephem-smoke": "s" }, {}], [{}, { wd: true }]] as const) {
      const r = validateRum(batch([span()], o), ctx(h)); if (!r.ok) throw new Error(r.reason)
      expect(r.rows[0]!.synthetic).toBe(true)
    }
  })
  it("bad envelopes are rejected with a status; bad spans are dropped one by one", () => {
    expect(validateRum(null, ctx())).toMatchObject({ ok: false, status: 400 })
    expect(validateRum(batch([], { tp: "00-nope" }), ctx())).toMatchObject({ ok: false, status: 400 })
    expect(validateRum(batch([], { tp: `00-${"0".repeat(32)}-${SID}-01` }), ctx())).toMatchObject({ ok: false, status: 400 })
    expect(validateRum(batch([], { page: "/admin" }), ctx())).toMatchObject({ ok: false, status: 400 })
    expect(validateRum(batch(Array.from({ length: RUM_LIMITS.maxSpans + 1 }, () => span())), ctx())).toMatchObject({ ok: false, status: 413 })
    const r = validateRum(batch([span({ k: "bogus" }), span({ sid: "XYZ" }), span({ t: "now" }), span({ k: "app", n: "Has Spaces<script>" }), span({ t: Infinity }), span({ dt: "<img src=x>", sv: '"><script>' }), 7]), ctx())
    if (!r.ok) throw new Error(r.reason)
    expect(r.rows).toHaveLength(1); expect(r.dropped).toBe(6)
    expect(r.rows[0]).not.toHaveProperty("detail"); expect(r.rows[0]).not.toHaveProperty("server_timing")
  })
  it("numbers are clamped and rounded", () => {
    const r = validateRum(batch([span({ d: 1e12, b: -5, st: 12345, ph: [-1, 1e9, "x", 1.23456] })]), ctx()); if (!r.ok) throw new Error(r.reason)
    expect(r.rows[0]).toMatchObject({ dur_ms: 3_600_000, transfer_bytes: 0, status: 999, dns_ms: 0, connect_ms: 3_600_000, request_ms: 1.235 })
    expect(r.rows[0]).not.toHaveProperty("tls_ms")
  })
  it("targetOf: route ids, known assets, else other", () => {
    expect(targetOf("/")).toBe("/"); expect(targetOf("/v1/day")).toBe("/v1/day"); expect(targetOf("/rum")).toBe("/rum")
    expect(targetOf("external")).toBe("external"); expect(targetOf("/v1/day/x")).toBe("other"); expect(targetOf(5)).toBeUndefined()
  })
  it("the limiter: per trace per minute, per isolate per 10 s", () => {
    const lim = makeLimiter({ ...RUM_LIMITS, perTracePerMin: 3, perIsolatePer10s: 5 })
    expect([1, 2, 3, 4].map(() => lim("t1", 0))).toEqual([true, true, true, false])
    expect(lim("t1", 61_000)).toBe(true)
    expect(lim("t2", 61_000)).toBe(true); expect(lim("t3", 61_000)).toBe(true); expect(lim("t4", 61_000)).toBe(true); expect(lim("t5", 61_000)).toBe(true)
    expect(lim("t6", 61_000)).toBe(false)   // 5 in this 10 s window
  })
})

describe("POST /rum", () => {
  const sinkOf = () => { const got: RumRow[] = []; const sink: RumSinkI = { version: "v-test", emit: r => { got.push(...r) } }; return { got, sink } }
  const post = (body: string, h: Record<string, string> = {}, sink?: RumSinkI) =>
    makeHandler(makeBlocks(origin))(new Request("http://x/rum", { method: "POST", headers: { "content-type": "application/json", ...h }, body }), undefined, sink)
  it("204, uncached, rows to the sink", async () => {
    const { got, sink } = sinkOf()
    const r = await post(JSON.stringify(batch([span(), span({ sid: "2222222222222222" })])), {}, sink)
    expect(r.status).toBe(204); expect(r.headers.get("cache-control")).toBe("no-store"); expect(r.headers.get("x-ephem-rum")).toBe("2 0")
    expect(got.map(x => x.span_id)).toEqual(["a1b2c3d4e5f60718", "2222222222222222"]); expect(got[0]!.version).toBe("v-test")
    expect(got.every(x => x.trace_id === TID)).toBe(true)
  })
  it("caps the body (413), rejects junk (400), honours DNT (204, nothing stored)", async () => {
    const { got, sink } = sinkOf()
    expect((await post("x".repeat(RUM_LIMITS.maxBytes + 1), {}, sink)).status).toBe(413)
    expect((await post("{", {}, sink)).status).toBe(400)
    expect((await post(JSON.stringify(batch([span()])), { dnt: "1" }, sink)).status).toBe(204)
    expect(got).toHaveLength(0)
  })
})

describe("Server-Timing", () => {
  it("every API response: blocks with count + cache path, the trace (a traceresponse), total last; no cpu entry", async () => {
    const r = await makeHandler(makeBlocks(origin))(new Request("http://x/v1/day?date=2026-10-28&tz=America/New_York&lat=40.6892&lon=-74.0445", { headers: { traceparent: TP } }))
    const st = r.headers.get("server-timing")!
    expect(st).toMatch(/^blocks;desc="ORIGIN:\d+ n=\d+";dur=[0-9.]+, geoid;desc="L1";dur=[0-9.]+, trace;desc="00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01", total;dur=[0-9.]+$/)
    expect(st).not.toMatch(/cpu/)
    expect(r.headers.get("timing-allow-origin")).toBe("*")
  })
  it("the front door names its cf-ray first, so RUM resource rows (documents, pages) join by ray", async () => {
    const r = await makeHandler(makeBlocks(origin))(new Request("http://x/llms.txt", { headers: { "cf-ray": "a52e17c739d64350-EWR" } }))
    expect(r.headers.get("server-timing")).toMatch(/^ray;desc="a52e17c739d64350-EWR", total;dur=/)
    const v = validateRum(batch([span({ k: "resource", n: "css", r: undefined, sv: 'ray;desc="a52e17c739d64350-EWR", total;dur=0.1' })]), ctx()); if (!v.ok) throw new Error(v.reason)
    expect(v.rows[0]!.ray).toBe("a52e17c739d64350-EWR")
  })
  it("documents: trace first, then total", async () => {
    const r = await makeHandler(makeBlocks(origin))(new Request("http://x/"))
    expect(r.headers.get("server-timing")).toMatch(/^trace;desc="00-[0-9a-f]{32}-[0-9a-f]{16}-01", total;dur=[0-9.]+$/)
  })
})

describe("request rows carry the trace", () => {
  it("trace ids (validated hex) + synthetic; matches the stream schema", async () => {
    const rows: RequestRow[] = []
    const sink: RequestLogSink = { version: "v", emit: r => { rows.push(r) } }
    await makeHandler(makeBlocks(origin))(new Request("http://x/v1/day?date=2026-10-28&tz=America/New_York&lat=40.6892&lon=-74.0445", { headers: { traceparent: TP, tracestate: "ephem=1234567890abcdef", "x-ephem-load": "J1" } }), sink)
    expect(rows[0]).toMatchObject({ synthetic: true, trace_id: TID, client_span_id: SID, client_parent_id: "1234567890abcdef", route: "/v1/day" })
    expect(rows[0]!.span_id).toMatch(/^[0-9a-f]{16}$/)
    const schema = JSON.parse(readFileSync(resolve(__dirname, "../ops/basin/requests.schema.json"), "utf8")) as Array<{ name: string; required: boolean }>
    for (const k of Object.keys(rows[0]!)) expect(schema.some(f => f.name === k), k).toBe(true)
    for (const f of schema) if (f.required) expect(rows[0], f.name).toHaveProperty(f.name)
  })
  it("ids that are not hex never reach a row", () => {
    const row = buildRow({ now: 0, method: "GET", url: new URL("http://x/nope"), headers: {}, status: 200, wallMs: 1, spanId: "nothex",
      spans: [new Map<string, unknown>([["client.trace_id", "<script>"], ["client.span_id", "zz"], ["client.trace_origin", "evil"]])] })
    for (const k of ["trace_id", "span_id", "client_span_id", "client_parent_id", "trace_origin"]) expect(row, k).not.toHaveProperty(k)
    expect(row.synthetic).toBe(false)
  })
})

describe("loopback trace propagation", () => {
  it("BlockStore fetches carry the request's trace id (not in the cache key: that is the URL)", async () => {
    const seen: Array<string | null> = []
    const lb = makeLoopback(() => ({ BlockStore: { fetch: async (req: Request) => { seen.push(req.headers.get("traceparent")); return new Response(new Uint8Array(REC), { status: 500 }) } } }))
    await lb.block(1, TP); await lb.geoid(2, TP); await lb.block(3)
    expect(seen).toEqual([TP, TP, null])
  })
  it("the Blocks loader passes the current span's traceparent (the client's trace id)", async () => {
    const tps: Array<string | undefined> = []
    const blocks = makeBlocks(async (i, tp) => { tps.push(tp); return origin(i) })
    await makeHandler(blocks)(new Request("http://x/v1/day?date=2026-10-28&tz=America/New_York&lat=40.6892&lon=-74.0445", { headers: { traceparent: TP } }))
    expect(tps.length).toBeGreaterThan(0)
    for (const t of tps) expect(t).toMatch(new RegExp(`^00-${TID}-[0-9a-f]{16}-01$`))
  })
})

describe("RUM_JS", () => {
  it("parses, and is off under DNT / GPC / no trace / unsampled", () => {
    expect(() => new Function(RUM_JS)).not.toThrow()
    const boot = (nav: Record<string, unknown>, trace: unknown, meta: string | null) => {
      const win: Record<string, unknown> = { __ephemTrace: trace, PerformanceObserver: function () {} }
      const document = { querySelector: () => meta == null ? null : { getAttribute: () => meta } }
      new Function("window", "navigator", "document", "performance", "addEventListener", "setInterval", "innerWidth", "devicePixelRatio", RUM_JS)(win, nav, document,
        { now: () => 1, getEntriesByType: () => [] }, () => {}, () => 0, 390, 3)
      return (win.__rum as { off: string | null }).off
    }
    const T = { traceId: TID, parentSpanId: SID, fetches: [], hex: (n: number) => "a".repeat(n * 2) }
    expect(boot({ doNotTrack: "1" }, T, TP)).toBe("privacy")
    expect(boot({ globalPrivacyControl: true }, T, TP)).toBe("privacy")
    expect(boot({}, undefined, TP)).toBe("no-trace")
    expect(boot({}, T, `00-${TID}-${SID}-00`)).toBe("unsampled")
  })
})
