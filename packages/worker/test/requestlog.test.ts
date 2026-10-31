// Basin request rows: built from the request's spans, privacy-safe, matching the stream schema, and never able to affect a response.
import { afterEach, describe, expect, it, vi } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { gzipSync } from "node:zlib"
import { makeHandler } from "../src/app.ts"
import { REC, R2_KEY, direct, makeBlocks, r2Origin, type R2BucketLike } from "../src/blocks.ts"
import { makeFeed, serveFeed } from "../src/metar-feed.ts"
import { weatherLive } from "../src/weather.ts"
import { LATEST } from "../src/mcp.ts"
import { buildRow, pipelineSink, round2, uaFamily, type RequestRow, type RequestLogSink } from "../src/requestlog.ts"
import { DE440 } from "@ephem/core"
import type { EphemRequestsRecord } from "../src/basin.generated.ts"

/** Compile-time: our row is assignable to the record `wrangler types` generates from the live stream schema. */
const typed = (r: RequestRow): EphemRequestsRecord => r

const FIX = resolve(__dirname, "../../core/test/fixtures")
const fixtureBlock = (i: number) => { const b = readFileSync(`${FIX}/blocks/${i}.bin`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer }
const bucket: R2BucketLike = {
  async get(key, opts) {
    if (key !== R2_KEY || !opts?.range) return null
    const { offset, length } = opts.range, out = new Uint8Array(length)
    for (let o = 0; o < length; o += REC) out.set(new Uint8Array(fixtureBlock((offset + o) / REC - 2)), o)
    return { size: DE440.sizeBytes, arrayBuffer: async () => out.buffer }
  },
  async head() { return { size: DE440.sizeBytes, customMetadata: { sha256: DE440.sha256 } } },
  async put() { throw new Error("read-only") },
}
const sample = readFileSync(resolve(__dirname, "fixtures/metars-sample.csv"), "utf8")
const weather = weatherLive(makeFeed({ minStations: 1, fetch: req => serveFeed(req, { log: () => {},
  fetch: async () => new Response(gzipSync(sample), { status: 200, headers: { etag: '"v1"', "last-modified": "Thu, 29 Oct 2026 11:25:16 GMT" } }) }) }))
const handler = makeHandler(makeBlocks(direct(r2Origin(bucket))), undefined, weather)

const SCHEMA = JSON.parse(readFileSync(resolve(__dirname, "../ops/basin/requests.schema.json"), "utf8")) as Array<{ name: string; type: string; required: boolean }>
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15"

/** A sink that collects rows. */
const collect = () => { const rows: RequestRow[] = []; const sink: RequestLogSink = { version: "v-test", emit: r => { rows.push(r) } }; return { rows, sink } }
const run = async (path: string, init?: RequestInit) => {
  const { rows, sink } = collect()
  const res = await handler(new Request("http://x" + path, { ...init, headers: { "user-agent": UA, "cf-ray": "8d00000000000000-EWR", ...(init?.headers as Record<string, string> | undefined) } }), sink)
  await res.arrayBuffer()
  return { res, rows }
}

/** Every key is a schema column with the right JS type; every required column is present. */
const matchesSchema = (row: RequestRow) => {
  const byName = new Map(SCHEMA.map(f => [f.name, f]))
  for (const [k, v] of Object.entries(row)) {
    const f = byName.get(k); expect(f, `column ${k}`).toBeDefined()
    const t = f!.type
    if (t === "string") expect(typeof v, k).toBe("string")
    else if (t === "bool") expect(typeof v, k).toBe("boolean")
    else if (t === "timestamp") expect(Number.isFinite(Date.parse(v as string)), k).toBe(true)
    else { expect(typeof v, k).toBe("number"); if (t.startsWith("int")) expect(Number.isInteger(v), k).toBe(true) }
  }
  for (const f of SCHEMA) if (f.required) expect(row, f.name).toHaveProperty(f.name)
}

afterEach(() => vi.restoreAllMocks())

describe("request rows (pure)", () => {
  it("rounds lat/lon to 0.01°, never keeps the raw query, user agent, path or IP", () => {
    const url = new URL("http://x/position?lat=40.712749&lon=-74.005949&time=2026-10-28T11:51:00Z&token=s3cret")
    const row = buildRow({ now: 0, method: "GET", url, headers: { "user-agent": UA, "cf-connecting-ip": "203.0.113.9", "cf-ray": "abc-EWR" },
      cf: { colo: "EWR", country: "US", city: "Brooklyn" }, status: 200, wallMs: 1.23456, spans: [new Map([["http.route", "/position"]])] })
    expect(row).toMatchObject({ lat_r: 40.7, lon_r: -73.99, route: "/position", ua_family: "browser", colo: "EWR", ray: "abc-EWR", ts: "1970-01-01T00:00:00.000Z", wall_ms: 1.235 })
    const json = JSON.stringify(row)
    for (const leak of ["s3cret", "token", "203.0.113.9", "Macintosh", "40.712749", "2026-10-28T11:51"]) expect(json).not.toContain(leak)
    matchesSchema(row); expect(typed(row)).toBe(row)
  })
  it("alignment rows take the target's coordinates; junk coordinates are dropped", () => {
    const s = [new Map()]
    expect(buildRow({ now: 0, method: "GET", url: new URL("http://x/alignment?targetLat=40.68925&targetLon=-74.0445"), headers: {}, status: 200, wallMs: 0, spans: s })).toMatchObject({ lat_r: 40.69, lon_r: -74.04 })
    const bad = buildRow({ now: 0, method: "GET", url: new URL("http://x/position?lat=91&lon=abc"), headers: {}, status: 400, wallMs: 0, spans: s })
    expect(bad).not.toHaveProperty("lat_r"); expect(bad.ok).toBe(false)
    expect(round2(-0.004)).toBe(-0); expect(round2(179.996)).toBe(180)
  })
  it("ephem-load traffic (x-ephem-load) is synthetic, and the run id is not logged", () => {
    const row = buildRow({ now: 0, method: "GET", url: new URL("http://x/position?lat=40.7&lon=-74"), headers: { "x-ephem-load": "L20261030T120000Z-ab12", "user-agent": "ephem-load/1 (run L20261030T120000Z-ab12)" }, status: 200, wallMs: 0, spans: [new Map()] })
    expect(row.synthetic).toBe(true); expect(row.ua_family).toBe("other"); expect(JSON.stringify(row)).not.toContain("L20261030T120000Z")
    matchesSchema(row)
  })
  it("ua_family is coarse", () => {
    expect(uaFamily("curl/8.7.1", undefined)).toBe("curl"); expect(uaFamily(UA, undefined)).toBe("browser")
    expect(uaFamily("python-requests/2.32", undefined)).toBe("other"); expect(uaFamily(undefined, undefined)).toBe("other")
    expect(uaFamily("node", "Claude Code/2.1.312")).toBe("mcp:claudecode"); expect(uaFamily("x", "<script>/1")).toBe("mcp:script")
  })
})

describe("request rows (through the app)", () => {
  it("a /day miss: one row with route, work counts and cache tiers", async () => {
    const { res, rows } = await run("/day?lat=40.7127&lon=-74.0059&height=-22.6&date=2026-10-28&tz=America/New_York")
    expect(res.status).toBe(200); expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(r).toMatchObject({ method: "GET", route: "/day", status: 200, ok: true, version: "v-test", lat_r: 40.7, lon_r: -73.99, ua_family: "browser", ray: "8d00000000000000-EWR" })
    expect(r.blocks).toBeGreaterThan(0); expect(r.block_reads).toBeGreaterThan(0); expect(r.origin_reads).toBeGreaterThanOrEqual(1); expect(r.origin_bytes).toBe(REC * ((r.blocks ?? 0) - (r.blocks_mem ?? 0)))   // fresh isolate: every block came from R2
    expect(r).not.toHaveProperty("error_tag"); expect(r).toMatchObject({ role: "front", blocks_cache: expect.stringMatching(/^ORIGIN/) })
    matchesSchema(r)
  })
  it("the front door's row for a forwarded API call: route from the path set, api_cache from the loopback; Api rows carry role api", async () => {
    const api = makeHandler(makeBlocks(direct(r2Origin(bucket))), { role: "api" }, weather)
    const apiRows: RequestRow[] = []
    const front = makeHandler(makeBlocks(direct(r2Origin(bucket))), { role: "front", api: async (pq, init) => {
      const r = await api(new Request("https://api.internal" + pq, init), { role: "api", emit: row => { apiRows.push(row) } }); const h = new Headers(r.headers); h.set("cf-cache-status", "HIT")
      return new Response(r.body, { status: r.status, headers: h }) } }, weather)
    const rows: RequestRow[] = []
    const res = await front(new Request("http://x/day?lat=40.7127&lon=-74.0059&date=2026-10-28&tz=America/New_York", { headers: { "user-agent": "curl/8", "cf-ray": "8d1-EWR" } }), { role: "front", emit: row => { rows.push(row) } })
    expect(res.status).toBe(200); expect(rows).toHaveLength(1); expect(apiRows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ role: "front", route: "/day", api_cache: "HIT", status: 200, ua_family: "curl", lat_r: 40.7 })
    expect(rows[0]).not.toHaveProperty("blocks")                       // the work happened in the Api invocation
    expect(apiRows[0]).toMatchObject({ role: "api", route: "/day", status: 200 }); expect(apiRows[0]!.ray).toBe(rows[0]!.ray); expect(apiRows[0]!.blocks).toBeGreaterThan(0)
    matchesSchema(rows[0]!); matchesSchema(apiRows[0]!)
  })
  it("ROUTES covers every documented path", async () => {
    const { ROUTES } = await import("../src/requestlog.ts")
    const paths = Object.keys(((await (await handler(new Request("http://x/openapi.json"))).json()) as { paths: Record<string, unknown> }).paths)
    for (const p of paths) expect(ROUTES.has(p), p).toBe(true)
  })
  it("ROUTES (src/routes.ts, shared with ephem-tail) is exactly what the router serves: every entry is routed, a near miss is 404", async () => {
    const { ROUTES } = await import("../src/requestlog.ts")
    expect(ROUTES).toBe((await import("../src/routes.ts")).ROUTES)
    for (const e of (await import("../src/docs.ts")).ENDPOINTS) expect(ROUTES.has(e.path), e.path).toBe(true)
    const POST = new Set(["/mcp", "/alignment/search", "/rum"])
    for (const p of ROUTES) {
      const r = await handler(new Request(`http://x${p}`, POST.has(p) ? { method: "POST", headers: { "content-type": "application/json" }, body: "{}" } : {}))
      expect(r.status, p).not.toBe(404)
    }
    expect((await handler(new Request("http://x/trak"))).status).toBe(404)
  })
  it("error_tag carries the typed error: InvalidRequest 400 (handler and schema), NotFound 404", async () => {
    const oor = await run("/position?lat=0&lon=0&time=1960-01-01T00:00:00Z")
    expect(oor.res.status).toBe(400); expect(oor.rows[0]).toMatchObject({ status: 400, ok: false, error_tag: "InvalidRequest", route: "/position" })
    const bad = await run("/position?lat=91&lon=0")
    expect(bad.res.status).toBe(400); expect(bad.rows[0]).toMatchObject({ status: 400, error_tag: "InvalidRequest", route: "/position" })
    const nf = await run("/no/such/path?secret=1")
    expect(nf.res.status).toBe(404); expect(nf.rows[0]).toMatchObject({ status: 404, error_tag: "RouteNotFound" }); expect(nf.rows[0]).not.toHaveProperty("route")
    expect(JSON.stringify(nf.rows)).not.toContain("/no/such")
    for (const r of [oor, bad, nf]) matchesSchema(r.rows[0]!)
  })
  it("/weather records the feed tier and data age", async () => {
    const { res, rows } = await run("/weather?lat=40.7&lon=-74&count=2")
    expect(res.status).toBe(200)
    expect(rows[0]).toMatchObject({ route: "/weather", weather_tier: expect.any(String), lat_r: 40.7, lon_r: -74 })
    expect(rows[0]!.data_age_s).toBeTypeOf("number"); matchesSchema(rows[0]!)
  })
  it("an MCP tools/call is one row (not one per in-process API call), with method, tool, client and the tool's work", async () => {
    const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "position", arguments: { lat: 40.7127, lon: -74.0059, time: "2026-10-28T11:51:00Z" },
      _meta: { "io.modelcontextprotocol/protocolVersion": LATEST, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "vitest", version: "1" } } } }
    const { res, rows } = await run("/mcp", { method: "POST", body: JSON.stringify(body),
      headers: { "content-type": "application/json", "mcp-protocol-version": LATEST, "mcp-method": "tools/call", "mcp-name": "position" } })
    expect(res.status).toBe(200); expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ method: "POST", route: "/mcp", mcp_method: "tools/call", mcp_tool: "position", ua_family: "mcp:vitest", lat_r: 40.7, lon_r: -73.99, status: 200 })
    expect(rows[0]!.blocks).toBeGreaterThan(0); matchesSchema(rows[0]!)
  })
  it("an MCP JSON-RPC error is tagged", async () => {
    const { rows } = await run("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "nope" }), headers: { "content-type": "application/json", "mcp-protocol-version": "2025-11-25" } })
    expect(rows[0]).toMatchObject({ mcp_method: "nope", error_tag: "MethodNotFound" })
  })
  it("without a sink nothing is logged and the response is the same", async () => {
    const p = "/position?lat=1&lon=2&time=2026-10-28T11:51:00Z"
    const res = await handler(new Request("http://x" + p)); expect(res.status).toBe(200)
    const { res: logged, rows } = await run(p); expect(logged.status).toBe(200); expect(rows).toHaveLength(1)
  })
})

describe("pipelineSink (the prod path)", () => {
  it("sends one row per request from waitUntil, never awaited by the response", async () => {
    const sent: RequestRow[][] = [], waits: Promise<unknown>[] = []
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const sink = pipelineSink({ send: async rs => { sent.push([...rs]); await gate } }, p => { waits.push(p) }, "ver-1")
    const res = await handler(new Request("http://x/position?lat=1&lon=2&time=2026-10-28T11:51:00Z"), sink)
    expect(res.status).toBe(200)                                  // returned while send is still pending
    expect(sent).toHaveLength(1); expect(sent[0]).toHaveLength(1); expect(sent[0]![0]).toMatchObject({ version: "ver-1", route: "/position" })
    expect(waits).toHaveLength(1); release(); await Promise.all(waits)
  })
  it("a rejecting send leaves the response untouched and logs one countable basin_send_failed line", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const waits: Promise<unknown>[] = []
    const sink = pipelineSink({ send: async () => { throw new Error("stream unavailable") } }, p => { waits.push(p) })
    const p = "/position?lat=1&lon=2&time=2026-10-28T11:51:00Z"
    const ok = await (await handler(new Request("http://x" + p))).text()
    const res = await handler(new Request("http://x" + p), sink)
    expect(res.status).toBe(200); expect(JSON.parse(await res.text()).sun).toEqual(JSON.parse(ok).sun)
    await expect(Promise.all(waits)).resolves.toBeDefined()         // the waitUntil promise never rejects
    const lines = err.mock.calls.map(c => String(c[0])).filter(l => l.includes("basin_send_failed"))
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).basin_send_failed).toMatchObject({ stream: "ephem_requests", route: "/position", status: 200, error: "Error: stream unavailable" })
  })
  it("a sink that throws synchronously cannot fail the request", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    const res = await handler(new Request("http://x/position?lat=1&lon=2&time=2026-10-28T11:51:00Z"), { emit: () => { throw new Error("boom") } })
    expect(res.status).toBe(200)
  })
})
