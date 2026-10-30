import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { gzipSync } from "node:zlib"
import { makeHandler } from "../src/app.ts"
import { setTracing } from "../src/trace.ts"
import { REC, R2_KEY, direct, makeBlocks, r2Origin, type R2BucketLike } from "../src/blocks.ts"
import { makeFeed, serveFeed } from "../src/metar-feed.ts"
import { weatherLive } from "../src/weather.ts"
import { LATEST, SUPPORTED_VERSIONS, TOOLS, originAllowed } from "../src/mcp.ts"
import { DE440 } from "@ephem/core"

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
const feed = makeFeed({ minStations: 1, fetch: req => serveFeed(req, { log: () => {},
  fetch: async () => new Response(gzipSync(sample), { status: 200, headers: { etag: '"v1"', "last-modified": "Thu, 29 Oct 2026 11:25:16 GMT" } }) }) })
const weather = weatherLive(feed)
const handler = makeHandler(makeBlocks(direct(r2Origin(bucket))), undefined, weather)

const POS = { lat: 40.7127, lon: -74.0059, height: -22.6, time: "2026-10-28T11:51:00Z" }
const DAY = { lat: 40.7127, lon: -74.0059, height: -22.6, date: "2026-10-28", tz: "America/New_York" }
const ALIGN = { body: "moon", targetLat: 40.68925, targetLon: -74.0445, targetHeight: 63.4, observerHeight: -30.9, start: "2026-10-28T23:45:00Z", end: "2026-10-29T02:00:00Z", stepSeconds: 1800, maxDistanceKm: 20, observerLat: 40.6892, observerLon: -74.076 }
const WX = { lat: 40.7, lon: -74, n: 3 }
const TRACK = { lat: 40.7127, lon: -74.0059, height: -22.6, start: "2026-10-28T00:00:00Z", end: "2026-10-28T06:00:00Z", stepSeconds: 1800 }
const REST: Record<string, [string, Record<string, unknown>]> = { sun_moon_position: ["/v1/position", POS], day_events: ["/v1/day", DAY], alignment: ["/v1/alignment", ALIGN], sun_moon_track: ["/v1/track", TRACK], weather_nearest: ["/v1/weather", WX] }

/** Modern (2026-07-28) request: _meta plus the mirrored headers. */
const modern = (method: string, params: Record<string, unknown> = {}, id: number | string = 1, extra: Record<string, string> = {}) => post({
  jsonrpc: "2.0", id, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": LATEST, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "vitest", version: "1" } } },
}, { "mcp-protocol-version": LATEST, "mcp-method": method, ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}), ...extra })
const legacy = (method: string, params?: Record<string, unknown>, id: number | string | null = 1, version = "2025-11-25") =>
  post({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) }, { "mcp-protocol-version": version })
async function post(body: unknown, headers: Record<string, string> = {}) {
  const r = await handler(new Request("http://x/mcp", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers } }))
  const text = await r.text()
  return { status: r.status, headers: r.headers, text, body: text ? JSON.parse(text) : undefined }
}
const restGet = async (path: string, q: Record<string, unknown>) => (await handler(new Request(`http://x${path}?${new URLSearchParams(Object.entries(q).map(([k, v]) => [k, String(v)]))}`))).json()
const strip = (x: any) => { const { provenance: _p, ...rest } = x; return rest }
/** The JSON that is a pure function of the inputs: provenance carries cache tiers / timings; weather has ages vs now. */
// weather: observer.magneticDeclination is full precision at "now", so two calls ms apart differ at ~1e-12°: compare it at 4 dp
const comparable = (tool: string, x: any) => tool === "weather_nearest" ? { stations: x.stations.map((s: any) => s.raw), observer: { ...x.observer, magneticDeclination: x.observer.magneticDeclination.toFixed(4) } } : strip(x)

describe("MCP handshake and discovery", () => {
  it("legacy initialize negotiates the client's version (or the newest legacy one), no session id", async () => {
    const r = await legacy("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } }, 0, undefined as any)
    expect(r.status).toBe(200); expect(r.headers.get("mcp-session-id")).toBeNull()
    expect(r.body.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ephem" } })
    expect((await legacy("initialize", { protocolVersion: "2024-11-05", capabilities: {} }, 0)).body.result.protocolVersion).toBe("2025-11-25")
    expect((await legacy("initialize", { protocolVersion: "2099-01-01", capabilities: {} }, 0)).body.result.protocolVersion).toBe("2025-11-25")
    const n = await legacy("notifications/initialized", undefined, null); expect(n.status).toBe(202); expect(n.text).toBe("")
    expect((await legacy("ping", undefined, 7)).body).toEqual({ jsonrpc: "2.0", id: 7, result: {} })
  })
  it("modern server/discover: versions, capabilities, serverInfo in _meta, resultType, cache hints", async () => {
    const r = await modern("server/discover")
    expect(r.status).toBe(200)
    expect(r.body.result).toMatchObject({ resultType: "complete", supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: {} }, cacheScope: "public" })
    expect(r.body.result._meta["io.modelcontextprotocol/serverInfo"].name).toBe("ephem")
  })
  it("tools/list: deterministic, schemas generated from the REST contract, every property documented", async () => {
    const r = await modern("tools/list"), tools = r.body.result.tools
    expect(tools.map((t: any) => t.name)).toEqual(["sun_moon_position", "day_events", "crossing", "alignment", "weather_nearest", "sun_moon_track"])
    expect((await legacy("tools/list")).body.result.tools).toEqual(tools)
    const pos = tools[0]
    expect(pos.inputSchema).toMatchObject({ type: "object", required: ["lat", "lon"], additionalProperties: false,
      properties: { lat: { type: "number", minimum: -90, maximum: 90 }, time: { type: "string" }, pressure: { minimum: 0, maximum: 1100 } } })
    expect(pos.outputSchema.required).toEqual(["time", "observer", "sun", "moon", "conventions", "provenance"])
    expect(tools[1].inputSchema.required).toEqual(["lat", "lon", "date", "tz"])
    expect(tools[2].inputSchema.properties.limb.enum).toEqual(["upper", "center", "lower"])
    expect(tools[3].inputSchema.properties.body.enum).toEqual(["sun", "moon"])
    expect(tools[4].inputSchema.properties.n.type).toBe("integer")
    expect(tools[5].inputSchema).toMatchObject({ required: ["lat", "lon", "start", "end"], properties: { stepSeconds: { type: "integer", minimum: 60, maximum: 3600 } } })
    for (const t of tools) for (const [k, v] of Object.entries<any>(t.inputSchema.properties)) expect(v.description, `${t.name}.${k}`).toBeTruthy()
    for (const t of TOOLS) expect(Object.keys(t.docs).toSorted()).toEqual(Object.keys(t.query).toSorted())   // docs cannot drift from the query either
    expect((await legacy("tools/list", undefined, 1, "2025-03-26")).body.result.tools[0].outputSchema).toBeUndefined()
  })
})

describe("tools/call equals the REST endpoint", () => {
  for (const [tool, [path, args]] of Object.entries(REST)) it(tool, async () => {
    const r = await modern("tools/call", { name: tool, arguments: args })
    expect(r.status).toBe(200); expect(r.body.result.isError).toBe(false)
    const sc = r.body.result.structuredContent
    expect(JSON.parse(r.body.result.content[0].text)).toEqual(sc)
    expect(comparable(tool, sc)).toEqual(comparable(tool, await restGet(path, args)))
    const old = await legacy("tools/call", { name: tool, arguments: args })
    expect(comparable(tool, old.body.result.structuredContent)).toEqual(comparable(tool, sc))
  })
  it("position without time is now", async () => {
    const t0 = Date.now(), r = await modern("tools/call", { name: "sun_moon_position", arguments: { lat: 0, lon: 0 } })
    expect(Date.parse(r.body.result.structuredContent.time.utc)).toBeGreaterThanOrEqual(t0 - 1)
  })
})

describe("errors", () => {
  it("bad arguments and out-of-range inputs are tool results with isError", async () => {
    const a = await modern("tools/call", { name: "sun_moon_position", arguments: { lat: 91, lon: "x" } })
    expect(a.status).toBe(200); expect(a.body.result.isError).toBe(true); expect(a.body.result.content[0].text).toMatch(/lat[\s\S]*lon|between -90 and 90/)
    const extra = await modern("tools/call", { name: "sun_moon_position", arguments: { lat: 1, lon: 2, latitude: 3 } }); expect(extra.body.result.isError).toBe(true)
    const range = await modern("tools/call", { name: "sun_moon_position", arguments: { lat: 0, lon: 0, time: "1960-01-01T00:00:00Z" } })
    expect(range.body.result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^OutOfRange: /) }] })
    const tz = await legacy("tools/call", { name: "day_events", arguments: { ...DAY, tz: "Mars/Olympus" } })
    expect(tz.body.result).toMatchObject({ isError: true, content: [{ text: expect.stringMatching(/^InvalidInput: unknown IANA time zone/) }] })
  })
  it("invalid params, unknown tool, unknown method: JSON-RPC errors", async () => {
    const p = await legacy("tools/call", { arguments: {} }); expect(p.body.error.code).toBe(-32602)
    const t = await modern("tools/call", { name: "nope", arguments: {} }); expect(t.body.error).toMatchObject({ code: -32602, message: "Unknown tool: nope" })
    const m = await modern("resources/list"); expect(m.status).toBe(404); expect(m.body.error.code).toBe(-32601)
    const lm = await legacy("prompts/list"); expect(lm.status).toBe(200); expect(lm.body).toMatchObject({ id: 1, error: { code: -32601 } })
    expect((await modern("ping")).body.error.code).toBe(-32601)   // ping was removed in 2026-07-28
  })
  it("parse error, invalid request, batches", async () => {
    const pe = await post("{not json"); expect(pe.status).toBe(400); expect(pe.body).toMatchObject({ id: null, error: { code: -32700 } })
    const ir = await post({ jsonrpc: "1.0", id: 3, method: "ping" }); expect(ir.status).toBe(400); expect(ir.body).toMatchObject({ id: 3, error: { code: -32600 } })
    const nb = await post([{ jsonrpc: "2.0", id: 1, method: "ping" }], { "mcp-protocol-version": "2025-11-25" }); expect(nb.status).toBe(400); expect(nb.body.error.code).toBe(-32600)
    const b = await post([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-03-26" } }])
    expect(b.status).toBe(200); expect(b.body).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }, expect.objectContaining({ id: 2, error: expect.objectContaining({ code: -32600 }) })])
    expect((await post([{ jsonrpc: "2.0", method: "notifications/initialized" }])).status).toBe(202)
    expect((await post({ jsonrpc: "2.0", id: 5, result: {} })).status).toBe(202)   // a client response is accepted and ignored
  })
  it("modern header and version rules", async () => {
    const mismatch = await modern("tools/list", {}, 1, { "mcp-protocol-version": "2025-11-25" }); expect(mismatch.status).toBe(400); expect(mismatch.body.error.code).toBe(-32020)
    const name = await modern("tools/call", { name: "alignment", arguments: ALIGN }, 1, { "mcp-name": "day_events" }); expect(name.body.error.code).toBe(-32020)
    const b64 = await modern("tools/call", { name: "day_events", arguments: DAY }, 1, { "mcp-name": `=?base64?${btoa("day_events")}?=` }); expect(b64.body.result.isError).toBe(false)
    const noMeta = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "mcp-protocol-version": LATEST }); expect(noMeta.status).toBe(400); expect(noMeta.body.error.code).toBe(-32602)
    const old = await post({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01", "io.modelcontextprotocol/clientCapabilities": {} } } },
      { "mcp-protocol-version": "1900-01-01", "mcp-method": "tools/list" })
    expect(old.status).toBe(400); expect(old.body.error).toMatchObject({ code: -32022, data: { supported: SUPPORTED_VERSIONS, requested: "1900-01-01" } })
    const legacyBad = await legacy("tools/list", undefined, 1, "2024-01-01"); expect(legacyBad.status).toBe(400)
    expect((await legacy("tools/list", undefined, 1, "2025-11-25")).headers.get("mcp-session-id")).toBeNull()
  })
  it("GET and DELETE are 405; bad Origin is 403; CORS allows POST", async () => {
    const g = await handler(new Request("http://x/mcp", { headers: { accept: "text/event-stream" } })); expect(g.status).toBe(405); expect(g.headers.get("allow")).toMatch(/POST/)
    expect((await handler(new Request("http://x/mcp", { method: "DELETE" }))).status).toBe(405)
    for (const o of ["http://evil.example", "null", "file://", "chrome-extension://abc", "not a url"]) expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: o })).status, o).toBe(403)
    for (const o of ["https://inspector.example", "http://localhost:6274", "http://127.0.0.1:6274"]) expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: o })).status, o).toBe(200)
    expect(originAllowed("http://x", "x")).toBe(true)
    const pre = await handler(new Request("http://x/mcp", { method: "OPTIONS" })); expect(pre.headers.get("access-control-allow-methods")).toMatch(/POST/)
    expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" })).headers.get("access-control-allow-origin")).toBe("*")
  })
})

describe("tracing (through the Workers tracing bridge, as in prod)", () => {
  it("one mcp.<method> span per message with the attributes; tools/call nests the REST handler, compute and blocks spans", async () => {
    const spans: Array<{ name: string; attrs: Record<string, unknown> }> = []
    setTracing({ startSpan: name => { const s = { name, attrs: {} as Record<string, unknown> }; spans.push(s)
      return { isTraced: true, setAttribute: (k: string, v: unknown) => { s.attrs[k] = v }, setStatus: () => {}, end: () => {} } } })
    try {
      const r = await modern("tools/call", { name: "sun_moon_position", arguments: POS }, "c1")
      expect(r.status).toBe(200)
      const mcp = spans.find(s => s.name === "mcp.tools/call")!
      expect(mcp.attrs).toMatchObject({ "mcp.method": "tools/call", "mcp.tool": "sun_moon_position", "jsonrpc.id": "c1", "mcp.protocol_version": LATEST, "mcp.client": "vitest/1", "mcp.is_error": false })
      const position = spans.find(s => s.name === "position")!; expect(position.attrs["effect.parent_id"]).toBe(mcp.attrs["effect.span_id"])
      expect(spans.find(s => s.name === "compute.position")!.attrs["effect.parent_id"]).toBe(position.attrs["effect.span_id"])
      expect(spans.find(s => s.name === "blocks.load")!.attrs["effect.parent_id"]).toBe(position.attrs["effect.span_id"])
      await legacy("nope", undefined, 2)
      expect(spans.find(s => s.name === "mcp.nope")!.attrs).toMatchObject({ "mcp.error_code": -32601, "mcp.is_error": true, "jsonrpc.id": "2" })
      await post("{")
      expect(spans.find(s => s.name === "mcp.parse_error")!.attrs).toMatchObject({ "mcp.error_code": -32700 })
      const bad = await modern("tools/call", { name: "sun_moon_position", arguments: { lat: 99, lon: 0 } }, "c2")
      expect(bad.body.result.isError).toBe(true)
      expect(spans.findLast(s => s.name === "mcp.tools/call")!.attrs).toMatchObject({ "jsonrpc.id": "c2", "mcp.is_error": true })
    } finally { setTracing(undefined) }
  })
})
