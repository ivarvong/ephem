// MCP server at /mcp: JSON-RPC 2.0 over Streamable HTTP, unauthenticated and stateless, written directly in Effect (no SDK).
//
// Dual-era (https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning):
//  - modern 2026-07-28: no handshake; every request carries _meta["io.modelcontextprotocol/protocolVersion"] and
//    clientCapabilities, mirrored in the MCP-Protocol-Version / Mcp-Method / Mcp-Name headers. Methods: server/discover,
//    tools/list, tools/call.
//  - legacy 2025-11-25, 2025-06-18, 2025-03-26: initialize handshake (the version is negotiated there), ping, tools/list,
//    tools/call, notifications. No Mcp-Session-Id is minted (sessions are optional); one sent by a client is ignored. A request
//    without MCP-Protocol-Version is 2025-03-26, the only version that allows JSON-RPC batches.
//
// Tools are the REST endpoints: arguments are decoded with the Type side of the endpoint's own query schema (so inputSchema is
// generated from it and cannot drift), encoded back to the query string with the same schema, and run through the router's own
// /* handler in this fiber, so tools/call nests the handler, compute.* and blocks.load spans and shares the response cache.
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as S from "effect/Schema"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import {
  paramDoc, MagneticQuery, MagneticResponse, AlignmentQuery, AlignmentResponse, SightlineQuery, SightlineResponse, SearchPayload, SearchResponse, CrossingQuery, CrossingResponse, DayQuery, DayResponse, PositionQuery, PositionResponse, TrackQuery, TrackResponse, WeatherQuery, WeatherResponse,
} from "@ephem/api"
import { VERSION } from "./handlers.ts"
import { VERSION_OVERRIDES } from "./responses.ts"
import { IN_PROCESS_ORIGIN } from "./clienttrace.ts"

export const LATEST = "2026-07-28"
export const LEGACY = ["2025-11-25", "2025-06-18", "2025-03-26"] as const
export const SUPPORTED_VERSIONS: ReadonlyArray<string> = [LATEST, ...LEGACY]
const NO_HEADER_VERSION = "2025-03-26"   // Streamable HTTP: a request without MCP-Protocol-Version MAY be treated as 2025-03-26
const META = "io.modelcontextprotocol/"
export const SERVER_INFO = { name: "ephem", title: "ephem: Sun and Moon ephemeris (JPL DE440)", version: VERSION }
const INSTRUCTIONS = "Topocentric Sun and Moon positions, rise/set/twilight events photo alignments and sight-line clearance computed from JPL DE440, plus the nearest METAR weather. Times are UTC ISO-8601 with a trailing Z; heights are metres above the WGS-84 ellipsoid unless heightRef=msl; unknown arguments are rejected; every response's conventions block states the thresholds, horizon, refraction and geoid used. Every tool returns the same JSON as the matching /v1 REST endpoint (https://ephem.ivar.workers.dev/docs)."
const MAX_BODY = 1 << 20

// ─────────────────────────────── JSON-RPC errors (typed) ───────────────────────────────
type Id = string | number | null
export class ParseError extends Data.TaggedError("ParseError")<{ readonly message: string }> { readonly code = -32700 }
export class InvalidRequest extends Data.TaggedError("InvalidRequest")<{ readonly message: string; readonly data?: unknown }> { readonly code = -32600 }
export class MethodNotFound extends Data.TaggedError("MethodNotFound")<{ readonly message: string }> { readonly code = -32601 }
export class InvalidParams extends Data.TaggedError("InvalidParams")<{ readonly message: string; readonly data?: unknown }> { readonly code = -32602 }
export class InternalError extends Data.TaggedError("InternalError")<{ readonly message: string }> { readonly code = -32603 }
export class HeaderMismatch extends Data.TaggedError("HeaderMismatch")<{ readonly message: string }> { readonly code = -32020 }
export class UnsupportedProtocolVersion extends Data.TaggedError("UnsupportedProtocolVersion")<{ readonly message: string; readonly data: { supported: ReadonlyArray<string>; requested: unknown } }> { readonly code = -32022 }
export type RpcError = ParseError | InvalidRequest | MethodNotFound | InvalidParams | InternalError | HeaderMismatch | UnsupportedProtocolVersion

const errorBody = (id: Id, e: RpcError) => ({ jsonrpc: "2.0" as const, id, error: { code: e.code, message: e.message, ...("data" in e && e.data !== undefined ? { data: e.data } : {}) } })
/** HTTP status for a JSON-RPC error. Modern: 400 for malformed / version / header errors, 404 for an unknown method (both
 *  spec MUSTs). Legacy clients (SDKs) treat non-2xx as a transport failure, so their in-protocol errors stay 200. */
const statusOf = (e: RpcError, modern: boolean, missingMeta: boolean) =>
  e.code === -32700 || e.code === -32600 ? 400
    : !modern ? (e.code === -32022 ? 400 : 200)
    : e.code === -32601 ? 404 : e.code === -32020 || e.code === -32022 || missingMeta ? 400 : 200

// ─────────────────────────────── message schemas ───────────────────────────────
const RequestId = S.Union([S.String, S.Int])
const Params = S.Record(S.String, S.Unknown)
const Message = S.Struct({ jsonrpc: S.Literal("2.0"), id: S.optionalKey(RequestId), method: S.String, params: S.optionalKey(Params) })
type Message = typeof Message.Type
const ClientResponse = S.Struct({ jsonrpc: S.Literal("2.0"), id: S.NullOr(RequestId) })
const Implementation = S.Struct({ name: S.String, version: S.String })
const InitializeParams = S.Struct({ protocolVersion: S.String, capabilities: S.optionalKey(Params), clientInfo: S.optionalKey(Implementation) })
const ModernMeta = S.Struct({ [`${META}protocolVersion`]: S.String, [`${META}clientCapabilities`]: Params, [`${META}clientInfo`]: S.optionalKey(Implementation) })
const CallParams = S.Struct({ name: S.String, arguments: S.optionalKey(Params) })
const decodeJson = S.decodeUnknownEffect(S.fromJsonString(S.Unknown))
const issue = (e: S.SchemaError) => e.message

// ─────────────────────────────── tools: the REST endpoints ───────────────────────────────
interface ToolDef {
  readonly name: string; readonly title: string; readonly description: string; readonly path: string
  readonly query: S.Struct.Fields; readonly success: S.Top; readonly docs: Readonly<Record<string, string>>; readonly openWorld?: boolean
  /** A POST endpoint: arguments are its JSON body (decoded with the Type side, encoded with the schema), `query` is unused. */
  readonly payload?: S.Top
}
/** Argument docs from the one parameter table (@ephem/api params.ts): the same words as /docs, /llms.txt and the 400 messages. */
const docsFor = (path: string, fields: S.Struct.Fields): Record<string, string> =>
  Object.fromEntries(Object.keys(fields).map(k => [k, paramDoc(path, k) ?? k]))
const tool = (name: string, title: string, path: string, query: S.Struct.Fields, success: S.Top, description: string, extra: Partial<ToolDef> = {}): ToolDef =>
  ({ name, title, path, query, success, docs: docsFor(path, query), description: `${description} Same as GET ${path}.`, ...extra })
export const TOOLS: ReadonlyArray<ToolDef> = [
  tool("position", "Sun and Moon position at an instant", "/position", PositionQuery, PositionResponse,
    "Where the Sun and Moon are for an observer at one instant (default now): azimuth, true and refracted altitude (apparentAltitude is null below the observer's horizon), altitude and azimuth rates (°/min), RA/Dec, distance, angular radius, ecliptic coordinates, and the Moon's phase and bright-limb angle (from celestial north and from the local vertical)."),
  tool("track", "Sun and Moon paths across the sky", "/track", TrackQuery, TrackResponse,
    "The Sun's and Moon's azimuth, true altitude and apparent altitude at every step of a UTC window (≤ 8 days, ≤ 1 441 samples), as parallel arrays; each sample equals position at that instant. For plotting paths or finding when a body is up."),
  tool("day", "Rise, set and twilight for a local day", "/day", DayQuery, DayResponse,
    "Sunrise, sunset, transit, civil / nautical / astronomical twilight, golden and blue hour, and moonrise, moonset and transit for one local calendar day, sorted by time. Rise and set use the sea-horizon dip from the observer's height above sea level and refraction from temperature and pressure (or a horizon / horizonProfile); conventions states every threshold used."),
  tool("crossing", "When the Sun or Moon reaches an altitude", "/crossing", CrossingQuery, CrossingResponse,
    "Every instant in a window (start/end ≤ 31 days, or one local date) when the Sun's or Moon's centre, a limb or the Moon's lit-area centroid (aim) reaches a true or apparent altitude, or a skyline profile; with direction, azimuth and altitude rate, and optional Sun / phase context."),
  tool("alignment", "Where to stand so the Sun or Moon sits on a landmark", "/alignment", AlignmentQuery, AlignmentResponse,
    "For each instant in [start, end], the ground point from which the Sun or Moon (centre, a limb, or the Moon's lit-area centroid: aim) sits exactly on a target: where to stand, distance, bearing, the body's rates there and the eye's heights; conventions states refraction, terrestrial refraction (k = 0.13) and height references. With lat/lon, also when the body passes the target as seen from that fixed spot."),
  { name: "alignment_search", title: "Every alignment pass over an area you can stand in", path: "/alignment/search", query: {}, payload: SearchPayload, success: SearchResponse,
    docs: docsFor("/alignment/search", SearchPayload.fields),
    description: "Every pass in a date range (≤ 400 days) when the alignment standing point (where the Sun or Moon sits exactly on the target) lies inside a region you can stand in (GeoJSON polygon or bbox), with exact entry and exit times and points per in-region segment, the body's azimuth / altitude, the Moon's illumination and the Sun's altitude per pass, and filters. One call instead of crossing → alignment → polygon clip → position. Same as POST /alignment/search." },
  tool("sightline", "Sight-line height and obstacle clearance", "/sightline", SightlineQuery, SightlineResponse,
    "The height above sea level of the sight line from an eye to a target against ground distance (Earth's curvature included; straight and with terrestrial refraction k = 0.13), and the clearance over given obstacle points (negative: the obstacle hides the target)."),
  tool("magnetic", "Magnetic declination", "/magnetic", MagneticQuery, MagneticResponse,
    "WMM2025 magnetic declination (east positive; magnetic bearing = true bearing − declination), inclination and field intensity at a place and time. Use it to turn the true azimuths of the other tools into compass bearings."),
  tool("weather", "Nearest METAR weather", "/weather", WeatherQuery, WeatherResponse,
    "The nearest METAR stations to a point (aviationweather.gov feed, cached up to 60 s fresh), decoded, with distance and true / magnetic bearing; temperature and pressure there are the refraction inputs of the other tools.", { openWorld: true }),
]

const jsonSchema = (schema: S.Top) => {
  const doc = S.toJsonSchemaDocument(schema) as { schema: Record<string, unknown>; definitions: Record<string, unknown> }
  return { ...doc.schema, ...(Object.keys(doc.definitions).length ? { $defs: doc.definitions } : {}) } as Record<string, unknown>
}
const argsSchema = (t: ToolDef): S.Top => t.payload ? S.toType(t.payload) : S.toType(S.Struct(t.query))
const inputSchemaOf = (t: ToolDef) => {
  const s = jsonSchema(argsSchema(t))
  const props = s.properties as Record<string, Record<string, unknown>>
  return { ...s, additionalProperties: false, properties: Object.fromEntries(Object.entries(props).map(([k, v]) => [k, t.docs[k] ? { ...v, description: t.docs[k] } : v])) }
}
/** Generated once per isolate: inputSchema from the Type side of the REST query schema, outputSchema from the REST response schema. */
const toolList = TOOLS.map(t => ({
  name: t.name, title: t.title, description: t.description, inputSchema: inputSchemaOf(t), outputSchema: jsonSchema(t.success),
  annotations: { title: t.title, readOnlyHint: true, destructiveHint: false, idempotentHint: !t.openWorld, openWorldHint: !!t.openWorld },
}))
export const listTools = (version: string) => version === "2025-03-26" ? toolList.map(({ outputSchema: _o, ...t }) => t) : toolList
const toolCodecs = new Map(TOOLS.map(t => [t.name, {
  def: t,
  decodeArgs: S.decodeUnknownEffect(argsSchema(t) as unknown as S.Codec<Record<string, unknown>, unknown>),
  encodeQuery: S.encodeEffect((t.payload ?? S.Struct(t.query)) as unknown as S.Codec<Record<string, unknown>, Record<string, string>>),
}]))

// ─────────────────────────────── dispatch ───────────────────────────────
type Rest = (path: string, query: Record<string, string>, body?: unknown) => Effect.Effect<{ status: number; body: any }, InternalError>
interface Ctx { readonly headers: Readonly<Record<string, string | undefined>>; readonly rest: Rest; readonly batch: boolean }
type Reply = { readonly status: number; readonly body: unknown } | undefined   // undefined: notification / client response, nothing to send

const toolText = (text: string, isError: boolean, structured?: unknown) => ({
  content: [{ type: "text", text }], ...(structured !== undefined ? { structuredContent: structured } : {}), isError,
})

const callTool = (params: Record<string, unknown> | undefined, ctx: Ctx, version: string) => Effect.gen(function* () {
  const p = yield* S.decodeUnknownEffect(CallParams)(params ?? {}).pipe(Effect.mapError(e => new InvalidParams({ message: `invalid tools/call params: ${issue(e)}` })))
  yield* Effect.annotateCurrentSpan({ "mcp.tool": p.name })
  const tool = toolCodecs.get(p.name)
  if (!tool) return yield* new InvalidParams({ message: `Unknown tool: ${p.name}`, data: { tools: TOOLS.map(t => t.name) } })
  const args = yield* tool.decodeArgs(p.arguments ?? {}, { errors: "all", onExcessProperty: "error" }).pipe(Effect.result)
  if (args._tag === "Failure") return toolText(`Invalid arguments for ${p.name}: ${issue(args.failure)}`, true)
  const query = yield* tool.encodeQuery(args.success).pipe(Effect.mapError(e => new InternalError({ message: `could not encode ${p.name} arguments: ${issue(e)}` })))
  const res = yield* (tool.def.payload ? ctx.rest(tool.def.path, {}, query) : ctx.rest(tool.def.path, query))
  yield* Effect.annotateCurrentSpan({ "mcp.rest_status": res.status })
  if (res.status === 200) return { ...toolText(JSON.stringify(res.body), false, version === "2025-03-26" ? undefined : res.body) }
  if (res.status >= 500 && res.status !== 503) return yield* new InternalError({ message: `${tool.def.path} failed with ${res.status}` })
  return toolText(`${res.body?._tag ?? "Error"}: ${res.body?.message ?? JSON.stringify(res.body)}`, true)
})

const b64 = /^=\?base64\?(.*)\?=$/
const headerValue = (v: string | undefined) => {
  const m = v === undefined ? null : b64.exec(v)
  if (!m) return v
  try { return new TextDecoder().decode(Uint8Array.from(atob(m[1]!), c => c.charCodeAt(0))) } catch { return undefined }
}

/** One JSON-RPC message → one span `mcp.<method>` → at most one reply. Errors are typed until here, then become JSON-RPC errors. */
const handleMessage = (raw: unknown, ctx: Ctx): Effect.Effect<Reply> => {
  const r = raw as Record<string, unknown> | null
  const looseId: Id = r && typeof r === "object" && (typeof r.id === "string" || typeof r.id === "number") ? r.id : null
  const method = r && typeof r === "object" && typeof r.method === "string" ? r.method : undefined
  let modern = false, missingMeta = false
  const body = Effect.gen(function* () {
    yield* Effect.annotateCurrentSpan({ "jsonrpc.id": looseId === null ? "" : String(looseId), "mcp.method": method ?? "", "mcp.batch": ctx.batch })
    const decoded = yield* S.decodeUnknownEffect(Message)(raw).pipe(Effect.result)
    if (decoded._tag === "Failure") {
      if (method === undefined && S.is(ClientResponse)(raw) && ("result" in (raw as object) || "error" in (raw as object))) return undefined   // a client response: accept, ignore
      return yield* new InvalidRequest({ message: `invalid JSON-RPC message: ${issue(decoded.failure)}` })
    }
    const m: Message = decoded.success
    const meta = (m.params?._meta ?? undefined) as Record<string, unknown> | undefined
    const headerVersion = ctx.headers["mcp-protocol-version"]
    modern = !ctx.batch && m.method !== "initialize" && meta !== undefined && `${META}protocolVersion` in meta
    if (m.id === undefined) {   // notification: accepted, never answered
      yield* Effect.annotateCurrentSpan({ "mcp.protocol_version": headerVersion ?? NO_HEADER_VERSION, "mcp.notification": true })
      return undefined
    }
    const ok = (result: Record<string, unknown>, version: string) => ({
      status: 200, body: { jsonrpc: "2.0", id: m.id, result: version === LATEST ? { resultType: "complete", ...result, _meta: { [`${META}serverInfo`]: SERVER_INFO } } : result },
    })

    if (modern) {
      const mm = yield* S.decodeUnknownEffect(ModernMeta)(meta).pipe(Effect.mapError(e => { missingMeta = true; return new InvalidParams({ message: `missing or invalid request _meta: ${issue(e)}` }) }))
      const version = mm[`${META}protocolVersion`] as string, client = mm[`${META}clientInfo`] as { name: string; version: string } | undefined
      yield* Effect.annotateCurrentSpan({ "mcp.protocol_version": version, ...(client ? { "mcp.client": `${client.name}/${client.version}` } : {}) })
      if (headerVersion === undefined) return yield* new HeaderMismatch({ message: "Header mismatch: MCP-Protocol-Version header is required" })
      if (headerVersion !== version) return yield* new HeaderMismatch({ message: `Header mismatch: MCP-Protocol-Version header value '${headerVersion}' does not match body value '${version}'` })
      if (version !== LATEST) return yield* new UnsupportedProtocolVersion({ message: "Unsupported protocol version", data: { supported: SUPPORTED_VERSIONS, requested: version } })
      const hm = ctx.headers["mcp-method"]
      if (hm !== m.method) return yield* new HeaderMismatch({ message: hm === undefined ? "Header mismatch: Mcp-Method header is required" : `Header mismatch: Mcp-Method header value '${hm}' does not match body value '${m.method}'` })
      if (m.method === "tools/call") {
        const hn = headerValue(ctx.headers["mcp-name"]), bn = m.params?.name
        if (hn !== bn) return yield* new HeaderMismatch({ message: hn === undefined ? "Header mismatch: Mcp-Name header is required" : `Header mismatch: Mcp-Name header value '${hn}' does not match body value '${String(bn)}'` })
      }
      switch (m.method) {
        case "server/discover": return ok({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: {} }, instructions: INSTRUCTIONS, ttlMs: 3_600_000, cacheScope: "public" }, version)
        case "tools/list": return ok({ tools: listTools(version), ttlMs: 3_600_000, cacheScope: "public" }, version)
        case "tools/call": return ok(yield* callTool(m.params, ctx, version), version)
        default: return yield* new MethodNotFound({ message: `Method not found: ${m.method}` })
      }
    }

    // legacy (initialize-era) semantics
    if (m.method === "initialize") {
      if (ctx.batch) return yield* new InvalidRequest({ message: "initialize must not be part of a JSON-RPC batch" })
      const p = yield* S.decodeUnknownEffect(InitializeParams)(m.params ?? {}).pipe(Effect.mapError(e => new InvalidParams({ message: `invalid initialize params: ${issue(e)}` })))
      const version = (LEGACY as ReadonlyArray<string>).includes(p.protocolVersion) ? p.protocolVersion : LEGACY[0]
      yield* Effect.annotateCurrentSpan({ "mcp.protocol_version": version, "mcp.requested_version": p.protocolVersion, ...(p.clientInfo ? { "mcp.client": `${p.clientInfo.name}/${p.clientInfo.version}` } : {}) })
      return ok({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS }, version)
    }
    const version = ctx.batch ? NO_HEADER_VERSION : headerVersion ?? NO_HEADER_VERSION
    yield* Effect.annotateCurrentSpan({ "mcp.protocol_version": version })
    if (version === LATEST) { missingMeta = true; modern = true; return yield* new InvalidParams({ message: `a ${LATEST} request must carry _meta["${META}protocolVersion"] and _meta["${META}clientCapabilities"]` }) }
    if (!(LEGACY as ReadonlyArray<string>).includes(version)) return yield* new UnsupportedProtocolVersion({ message: `Unsupported MCP-Protocol-Version: ${version}`, data: { supported: SUPPORTED_VERSIONS, requested: version } })
    switch (m.method) {
      case "ping": return ok({}, version)
      case "tools/list": return ok({ tools: listTools(version) }, version)
      case "tools/call": return ok(yield* callTool(m.params, ctx, version), version)
      default: return yield* new MethodNotFound({ message: `Method not found: ${m.method}` })
    }
  })
  return body.pipe(
    Effect.catch((e: RpcError) => Effect.as(Effect.annotateCurrentSpan({ "mcp.error_code": e.code }), { status: statusOf(e, modern, missingMeta), body: errorBody(looseId, e) } as Reply)),
    Effect.tap(reply => {
      const result = (reply?.body as any)?.result
      return Effect.annotateCurrentSpan({ "mcp.is_error": result?.isError === true || (reply?.body as any)?.error !== undefined, "http.status_code": reply?.status ?? 202 })
    }),
    Effect.catchDefect(d => Effect.succeed<Reply>({ status: 500, body: errorBody(looseId, new InternalError({ message: `internal error: ${String(d)}` })) })),
    Effect.withSpan(`mcp.${method ?? "invalid"}`),
  )
}

// ─────────────────────────────── HTTP binding ───────────────────────────────
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])
/** DNS-rebinding guard (spec: validate Origin, 403 when present and invalid). Non-browser clients send no Origin and pass.
 *  This is a public read-only API, so any https origin may call it (CORS is open); plain http only from loopback or this
 *  host; "null", file:, extension and malformed origins are refused. */
export const originAllowed = (origin: string | undefined, host: string | undefined): boolean => {
  if (origin === undefined) return true
  let u: URL
  try { u = new URL(origin) } catch { return false }
  if (u.origin === "null" || u.origin !== origin.replace(/\/$/, "")) return false
  if (u.protocol === "https:") return true
  return u.protocol === "http:" && (LOOPBACK.has(u.hostname) || u.host === host)
}

const json = (status: number, body: unknown) => HttpServerResponse.jsonUnsafe(body, { status })
const notAllowed = HttpServerResponse.jsonUnsafe(
  { jsonrpc: "2.0", id: null, error: { code: -32600, message: "This MCP endpoint is stateless and offers no server-initiated stream: POST JSON-RPC messages to /mcp." } },
  { status: 405, headers: { allow: "POST, OPTIONS" } })

const handlePost = (req: HttpServerRequest.HttpServerRequest, rest: Rest) => Effect.gen(function* () {
  const headers = req.headers as Readonly<Record<string, string | undefined>>
  if (!originAllowed(headers.origin, headers.host)) {
    yield* Effect.annotateCurrentSpan({ "mcp.origin_rejected": headers.origin ?? "" })
    return json(403, { jsonrpc: "2.0", error: { code: -32600, message: `Forbidden Origin: ${headers.origin}` } })
  }
  if (Number(headers["content-length"] ?? 0) > MAX_BODY) return json(413, errorBody(null, new InvalidRequest({ message: `body larger than ${MAX_BODY} bytes` })))
  const text = yield* req.text.pipe(Effect.orElseSucceed(() => ""))
  if (text.length > MAX_BODY) return json(413, errorBody(null, new InvalidRequest({ message: `body larger than ${MAX_BODY} bytes` })))
  const parsed = yield* decodeJson(text).pipe(Effect.result)
  if (parsed._tag === "Failure") {
    const e = new ParseError({ message: `Parse error: ${issue(parsed.failure)}` })
    yield* Effect.annotateCurrentSpan({ "mcp.error_code": e.code, "mcp.is_error": true }).pipe(Effect.withSpan("mcp.parse_error"))
    return json(400, errorBody(null, e))
  }
  const msg = parsed.success
  if (Array.isArray(msg)) {
    const version = headers["mcp-protocol-version"]
    if (version !== undefined && version !== NO_HEADER_VERSION)
      return json(400, errorBody(null, new InvalidRequest({ message: `JSON-RPC batches are not allowed in protocol version ${version} (only ${NO_HEADER_VERSION})` })))
    if (msg.length === 0) return json(400, errorBody(null, new InvalidRequest({ message: "empty batch" })))
    const replies = yield* Effect.forEach(msg, m => handleMessage(m, { headers, rest, batch: true }))
    const bodies = replies.filter(r => r !== undefined).map(r => r.body)
    return bodies.length === 0 ? HttpServerResponse.empty({ status: 202 }) : json(200, bodies)
  }
  const reply = yield* handleMessage(msg, { headers, rest, batch: false })
  return reply === undefined ? HttpServerResponse.empty({ status: 202 }) : json(reply.status, reply.body)
})

/** Registers POST/GET/DELETE /mcp. Tool calls dispatch to the router's own API routes, in-process, in the caller's fiber. */
export const Mcp = HttpRouter.use(router => Effect.gen(function* () {
  // fwd: the outer request's cf-ray and version override, so a tool's forward to the Api is joined
  // to this request's row and pinned like the REST call would be.
  const restWith = (fwd: Record<string, string>): Rest => (path, query, body) => Effect.gen(function* () {
    const inner = HttpServerRequest.fromWeb(body === undefined ? new Request(`${IN_PROCESS_ORIGIN}${path}?${new URLSearchParams(query)}`, { headers: fwd })
      : new Request(`${IN_PROCESS_ORIGIN}${path}`, { method: "POST", headers: { ...fwd, "content-type": "application/json" }, body: JSON.stringify(body) }))
    const res = yield* router.asHttpEffect().pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, inner), Effect.scoped)
    const web = HttpServerResponse.toWeb(res)
    const text = yield* Effect.promise(() => web.text())
    return { status: web.status, body: text ? JSON.parse(text) : null }
  }).pipe(Effect.catchCause(c => Effect.fail(new InternalError({ message: `${path}: ${String(c)}` }))))
  yield* router.add("POST", "/mcp", req => {
    const h = req.headers as Readonly<Record<string, string | undefined>>, fwd: Record<string, string> = {}
    if (h["cf-ray"]) fwd["cf-ray"] = h["cf-ray"]   // the inner request looks like the outer one to Gateway (forwardHeaders)
    if (h[VERSION_OVERRIDES]) fwd[VERSION_OVERRIDES] = h[VERSION_OVERRIDES]
    return handlePost(req, restWith(fwd))
  })
  yield* router.add("GET", "/mcp", notAllowed)
  yield* router.add("DELETE", "/mcp", notAllowed)
}))
