// Client ↔ server trace correlation (W3C Trace Context). The page (/) sends `traceparent` on every API fetch:
// one trace id per page load, one span id per fetch (packages/web/src/client/trace.ts). The front door validates it, records the two ids on the
// root Effect span (`client.trace_id`, `client.span_id`) and echoes the trace id as `x-ephem-trace`; forwards to the Api carry
// the same header (responses.ts forwardHeaders), so the Api's root span has the ids too. Effect's HttpMiddleware.tracer also
// parents the request span on it, so `effect.parent_id` of the root span = the client's span id.
// Only the two hex ids are ever recorded: the header itself, tracestate and anything malformed are dropped. Never in request
// rows (requestlog.ts reads only ATTR). scripts/obs/journey.ts joins on these and on cf-ray.
import * as Effect from "effect/Effect"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { Edge } from "./responses.ts"
import { parseTraceparent } from "./traceparent.ts"
export { parseTraceparent }

export const TRACE_HEADER = "x-ephem-trace"
/** Origin of in-process router calls (the homepage's embeds, src/embed.ts; MCP's tools, src/mcp.ts). They run in the caller's
 *  fiber, so the current span is the caller's (home.embed, a tool span): ClientTrace skips them, or that span would also carry
 *  client.trace_id with the document's span id as client.span_id and the journey would join the document by cf-ray only. */
export const IN_PROCESS_ORIGIN = "http://ephem.internal"

const hex = (n: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("")
const HEX16 = /^[0-9a-f]{16}$/

/** The page route (/) carries trace context too (OTel document-load convention). The document's trace id is the
 *  incoming traceparent's (adopted: Effect's HttpMiddleware.tracer already parents the root span on it) or a fresh one; its
 *  span id is the root Effect request span's own id (`effect.span_id` on that Workers span), so the page's fetch spans are
 *  its children. Recorded on the root span: `client.trace_id`, `client.document_span_id`, `client.trace_origin`
 *  (`adopted` | `minted`; with `client.span_id` = the incoming parent when adopted). Returned to the page as
 *  `<meta name="traceparent">` (read first by the page: packages/web/src/client/trace.ts), `Server-Timing: trace;desc="<traceparent>"` (the navigation
 *  entry's serverTiming) and `x-ephem-trace` (curl, CDP). Call it outside the handler's own withSpan, so the current span is
 *  the root request span. The HTML is `private, no-store` and never forwarded to the cached Api, so a per-response id is safe. */
export const documentTrace = (req: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const tp = parseTraceparent(req.headers["traceparent"])
    const span = yield* Effect.option(Effect.currentSpan)
    const cur = span._tag === "Some" ? span.value : undefined
    // No trace header at all: the root Effect span's own trace id (so loopbacks propagate the same id). A trace header that
    // W3C rejects: a fresh id, since Effect's lenient parser may have parented the span on it.
    const traceId =
      tp?.traceId ??
      (!req.headers["traceparent"] &&
      !req.headers["b3"] &&
      !req.headers["x-b3-traceid"] &&
      cur &&
      /^[0-9a-f]{32}$/.test(cur.traceId)
        ? cur.traceId
        : hex(16))
    const spanId = cur && HEX16.test(cur.spanId) ? cur.spanId : hex(8)
    yield* Effect.annotateCurrentSpan({
      "client.trace_id": traceId,
      "client.document_span_id": spanId,
      "client.trace_origin": tp ? "adopted" : "minted",
    })
    // Synthetic (ephem-load, smoke, the CDP journey harness): the page's RUM flags its rows, including the pagehide beacon, which
    // carries none of the harness's request headers.
    const synthetic = !!(req.headers["x-ephem-load"] || req.headers["x-ephem-smoke"])
    return { traceId, spanId, traceparent: `00-${traceId}-${spanId}-01`, synthetic }
  })
export type DocumentTrace = {
  readonly traceId: string
  readonly spanId: string
  readonly traceparent: string
  readonly synthetic?: boolean
}
/** Response headers of a page: the id for CDP, curl and the navigation entry's serverTiming. */
export const documentTraceHeaders = (d: DocumentTrace): Record<string, string> => ({
  [TRACE_HEADER]: d.traceId,
  "server-timing": `trace;desc="${d.traceparent}"`,
})

export const ClientTrace = HttpRouter.middleware(
  Effect.gen(function* () {
    const edge = yield* Edge
    return (http) =>
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest
        const tp = parseTraceparent(req.headers["traceparent"])
        if (!tp || req.originalUrl.startsWith(IN_PROCESS_ORIGIN + "/")) return yield* http
        // tracestate `ephem=<16 hex>`: the client span's own parent (the page's document span), so the server knows the chain.
        const parent = /(?:^|,)\s*ephem=([0-9a-f]{16})\s*(?:,|$)/.exec(req.headers["tracestate"] ?? "")?.[1]
        yield* Effect.annotateCurrentSpan({
          "client.trace_id": tp.traceId,
          "client.span_id": tp.spanId,
          ...(parent && !/^0+$/.test(parent) ? { "client.parent_id": parent } : {}),
        })
        const res = yield* http
        // The Api's answers are cached by Workers Caching: an echo there would be replayed to other clients.
        return edge.role === "api" ? res : HttpServerResponse.setHeader(res, TRACE_HEADER, tp.traceId)
      })
  }),
  { global: true },
)
