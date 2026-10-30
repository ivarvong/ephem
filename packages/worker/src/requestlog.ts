// Request logs: one row per request to the Basin stream `ephem_requests` (schema: ops/basin/requests.schema.json), sent from
// waitUntil so the response never waits on it. The row is read from what the request already records on its spans: the
// middleware runs the request under a tracer that delegates to the real one and keeps every span it creates, then reads their
// attributes and exits. Handlers, MCP and the weather service need no logging code; renaming a span attribute listed in ATTR
// changes a column (test/requestlog.test.ts pins them).
//
// Privacy: no IP, no raw path or query string, no full user agent. lat/lon are rounded to 0.01° (~1 km).
import * as Cause from "effect/Cause"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Tracer from "effect/Tracer"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerError from "effect/http/HttpServerError"
import * as HttpServerRequest from "effect/http/HttpServerRequest"

declare const __EPHEM_BUILD__: string
const BUILD = typeof __EPHEM_BUILD__ === "string" ? __EPHEM_BUILD__ : "dev"

/** One `ephem_requests` row. Optional columns are omitted (not null) when unknown. Mirrors ops/basin/requests.schema.json. */
export interface RequestRow {
  ts: string; ray?: string; version?: string; build?: string; role: string; colo?: string; country?: string; city?: string
  method: string; route?: string; status: number; ok: boolean; error_tag?: string; wall_ms: number
  api_cache?: string; blocks_cache?: string; feed_cache?: string
  blocks?: number; blocks_mem?: number; origin_reads?: number; origin_bytes?: number; block_reads?: number; iterations?: number
  weather_tier?: string; data_age_s?: number; mcp_method?: string; mcp_tool?: string; ua_family: string; lat_r?: number; lon_r?: number
}

/** Where a row goes. Provided per request (makeHandler's second argument); absent → nothing is logged. `role` is which entrypoint
 *  logged it: "front" (the uncached front door: one row for every request) or "api" (the cached Api entrypoint: one row per
 *  execution, i.e. per cache miss or revalidation, carrying the work counts). */
export interface RequestLogSink { readonly version?: string | undefined; readonly role?: string | undefined; readonly emit: (row: RequestRow) => void }
export class RequestLog extends Context.Service<RequestLog, RequestLogSink>()("@ephem/worker/RequestLog") {}

/** Span attributes → columns. The cache statuses are set by the cache layer (cf-cache-status of the internal fetch). */
export const ATTR = {
  route: "http.route", errorTag: "ephem.error_tag",
  apiCache: "ephem.api_cache", blocksCache: "ephem.blocks_cache", feedCache: "ephem.feed_cache",
  // blocks_mem: isolate L1 hits. origin_reads / origin_bytes: blocks fetched past L1 (any tier: BlockStore loopback or R2), from
  // cache.blocks_<status> (one key per cf-cache-status) and cache.fetchedBytes.
  blocks: "blocks.count", blocksMem: "cache.l1", fetchedPrefix: "cache.blocks_", originBytes: "cache.fetchedBytes",
  blockReads: "ephem.block_reads", iterations: "ephem.iterations",
  weatherTier: "metar.tier", dataAge: "metar.data_age_s",
  mcpMethod: "mcp.method", mcpTool: "mcp.tool", mcpClient: "mcp.client", mcpErrorCode: "mcp.error_code",
} as const

const RPC_TAGS: Record<number, string> = { [-32700]: "ParseError", [-32600]: "InvalidRequest", [-32601]: "MethodNotFound", [-32602]: "InvalidParams",
  [-32603]: "InternalError", [-32020]: "HeaderMismatch", [-32022]: "UnsupportedProtocolVersion" }

export const round2 = (x: number) => Math.round(x * 100) / 100
const coord = (s: string | null, lim: number) => { if (s === null || s.trim() === "") return undefined; const x = Number(s); return Number.isFinite(x) && Math.abs(x) <= lim ? round2(x) : undefined }

/** curl / browser / mcp:<client name> / other. Never the full user agent. */
export const uaFamily = (ua: string | undefined, mcpClient: string | undefined): string => {
  if (mcpClient) { const name = mcpClient.split("/")[0]!.toLowerCase().replace(/[^a-z0-9._-]/g, "").slice(0, 32); if (name) return `mcp:${name}` }
  if (!ua) return "other"
  if (/^curl\//i.test(ua)) return "curl"
  if (ua.startsWith("Mozilla/")) return "browser"
  return "other"
}

/** The tag of a typed failure or defect: `_tag`, or the HttpServerError reason (RouteNotFound), or the error's name. */
export const tagOf = (e: unknown): string | undefined => {
  if (e === null || typeof e !== "object") return undefined
  const o = e as { _tag?: unknown; reason?: { _tag?: unknown }; name?: unknown }
  if (o._tag === "HttpServerError" && typeof o.reason?._tag === "string") return o.reason._tag
  if (typeof o._tag === "string") return o._tag
  return typeof o.name === "string" ? o.name : undefined
}
const causeTag = (c: Cause.Cause<unknown>): string | undefined => {
  const err = Cause.findErrorOption(c)
  if (Option.isSome(err)) return tagOf(err.value)
  const d = Cause.findDefect(c)
  return d._tag === "Success" ? tagOf(d.success) ?? "Defect" : undefined
}

type Attrs = ReadonlyMap<string, unknown>
const firstStr = (spans: ReadonlyArray<Attrs>, k: string) => { for (const a of spans) { const v = a.get(k); if (typeof v === "string" && v !== "") return v } return undefined }
const firstNum = (spans: ReadonlyArray<Attrs>, k: string) => { for (const a of spans) { const v = a.get(k); if (typeof v === "number" && Number.isFinite(v)) return v } return undefined }
const sum = (spans: ReadonlyArray<Attrs>, k: string) => { let s = 0, seen = false; for (const a of spans) { const v = a.get(k); if (typeof v === "number" && Number.isFinite(v)) { s += v; seen = true } } return seen ? s : undefined }
const sumPrefix = (spans: ReadonlyArray<Attrs>, p: string) => { let s = 0, seen = false; for (const a of spans) for (const [k, v] of a) if (k.startsWith(p) && typeof v === "number" && Number.isFinite(v)) { s += v; seen = true } return seen ? s : undefined }

/** Every route is a static path, so on the front door (which forwards /v1/* without matching) the path is the route if it is one
 *  of these; anything else is left out rather than stored raw. test/requestlog.test.ts checks this covers /openapi.json. */
export const ROUTES: ReadonlySet<string> = new Set(["/", "/docs", "/openapi.json", "/healthz", "/mcp", "/v1/position", "/v1/day", "/v1/crossing", "/v1/alignment", "/v1/track", "/v1/magnetic", "/v1/weather"])

export interface RowInput {
  readonly now: number; readonly method: string; readonly url: URL; readonly headers: Readonly<Record<string, string | undefined>>
  readonly cf?: { readonly colo?: unknown; readonly country?: unknown; readonly city?: unknown } | undefined
  readonly status: number; readonly wallMs: number; readonly version?: string | undefined; readonly role?: string | undefined
  /** The request span's attributes, then every span the request created, in creation order. */
  readonly spans: ReadonlyArray<Attrs>
  /** Tag of the request's own failure, else of the first span that ended in failure. */
  readonly errorTag?: string | undefined
  /** URLs of in-process sub-requests (MCP tools/call → /v1/*), for lat/lon. */
  readonly inner?: ReadonlyArray<URL>
}

/** Pure: the row for one request. */
export const buildRow = (i: RowInput): RequestRow => {
  const s = i.spans
  const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined)
  const loc = [i.url, ...(i.inner ?? [])].map(u => ({ lat: coord(u.searchParams.get("lat") ?? u.searchParams.get("targetLat"), 90), lon: coord(u.searchParams.get("lon") ?? u.searchParams.get("targetLon"), 180) }))
    .find(l => l.lat !== undefined && l.lon !== undefined)
  const rpc = firstNum(s, ATTR.mcpErrorCode)
  const row: Record<string, unknown> = {
    ts: new Date(i.now).toISOString(), ray: str(i.headers["cf-ray"]) ?? str(i.headers["x-ephem-ray"]) /* the Api gets the front's ray as x-ephem-ray */, version: i.version, build: BUILD, role: i.role ?? "front",
    colo: str(i.cf?.colo), country: str(i.cf?.country), city: str(i.cf?.city),
    method: i.method, route: firstStr(s, ATTR.route) ?? (ROUTES.has(i.url.pathname) ? i.url.pathname : undefined), status: i.status, ok: i.status < 400,
    error_tag: firstStr(s, ATTR.errorTag) ?? i.errorTag ?? (rpc !== undefined ? RPC_TAGS[rpc] ?? `rpc${rpc}` : undefined),
    wall_ms: Math.round(i.wallMs * 1000) / 1000,
    api_cache: firstStr(s, ATTR.apiCache), blocks_cache: firstStr(s, ATTR.blocksCache), feed_cache: firstStr(s, ATTR.feedCache),
    blocks: sum(s, ATTR.blocks), blocks_mem: sum(s, ATTR.blocksMem), origin_reads: sumPrefix(s, ATTR.fetchedPrefix), origin_bytes: sum(s, ATTR.originBytes),
    block_reads: sum(s, ATTR.blockReads), iterations: sum(s, ATTR.iterations),
    weather_tier: firstStr(s, ATTR.weatherTier), data_age_s: firstNum(s, ATTR.dataAge),
    mcp_method: firstStr(s, ATTR.mcpMethod), mcp_tool: firstStr(s, ATTR.mcpTool),
    ua_family: uaFamily(i.headers["user-agent"], firstStr(s, ATTR.mcpClient)),
    lat_r: loc?.lat, lon_r: loc?.lon,
  }
  for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k]
  return row as unknown as RequestRow
}

interface Active { readonly inner: Array<URL> }
const ActiveLog = Context.Reference<Active | undefined>("@ephem/worker/RequestLog/active", { defaultValue: () => undefined })

const failedTag = (spans: ReadonlyArray<Tracer.Span>) => {
  for (const sp of spans) if (sp.status._tag === "Ended" && Exit.isFailure(sp.status.exit)) { const t = causeTag(sp.status.exit.cause); if (t) return t }
  return undefined
}

/** Global middleware: runs the request with a recording tracer, then emits the row. Never fails or delays the response. */
export const RequestLogging = HttpRouter.middleware(http => Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const active = yield* ActiveLog
  if (active) { active.inner.push(new URL(req.originalUrl, "http://localhost")); return yield* http }   // MCP's in-process /v1 call
  const sink = yield* Effect.serviceOption(RequestLog)
  if (Option.isNone(sink)) return yield* http
  const base = yield* Effect.tracer
  const spans: Array<Tracer.Span> = []
  const recording = Tracer.make({ span(o) { const sp = base.span(o); spans.push(sp); return sp }, ...(base.context ? { context: base.context } : {}) })
  const mine: Active = { inner: [] }
  const t0 = performance.now()
  const exit = yield* http.pipe(Effect.withTracer(recording), Effect.provideService(ActiveLog, mine), Effect.exit)
  const wallMs = performance.now() - t0
  const status = Exit.isSuccess(exit) ? exit.value.status : (yield* HttpServerError.causeResponse(exit.cause))[0].status
  const reqSpan = yield* Effect.option(Effect.currentSpan)
  yield* Effect.sync(() => {
    try {
      const source = req.source as { cf?: RowInput["cf"] } | undefined
      sink.value.emit(buildRow({
        now: Date.now(), method: req.method, url: new URL(req.originalUrl, "http://localhost"), headers: req.headers as Readonly<Record<string, string | undefined>>,
        cf: source?.cf, status, wallMs, version: sink.value.version, role: sink.value.role,
        spans: [...(Option.isSome(reqSpan) ? [reqSpan.value.attributes] : []), ...spans.map(sp => sp.attributes)],
        errorTag: Exit.isFailure(exit) ? causeTag(exit.cause) ?? failedTag(spans) : failedTag(spans), inner: mine.inner,
      }))
    } catch (e) { console.error(JSON.stringify({ request_log_failed: String(e) })) }
  })
  return yield* exit
}), { global: true })

/** Minimal shape of a Pipelines binding (`env.LOGS`); typed by our row rather than the generic PipelineRecord. */
export interface PipelineLike<T> { send(records: ReadonlyArray<T>): Promise<void> }

/** The prod sink: send from waitUntil, never awaited by the response; a failed send is one countable error line. */
export const pipelineSink = (logs: PipelineLike<RequestRow>, waitUntil: (p: Promise<unknown>) => void, version?: string, role = "front"): RequestLogSink => ({
  version, role,
  emit: row => waitUntil(logs.send([row]).catch((e: unknown) =>
    console.error(JSON.stringify({ basin_send_failed: { stream: "ephem_requests", role, route: row.route ?? null, status: row.status, ray: row.ray ?? null, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) } })))),
})
