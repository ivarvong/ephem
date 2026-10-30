// Client ↔ server trace correlation (W3C Trace Context). The pages (/, /instrument) send `traceparent` on every API fetch:
// one trace id per page load, one span id per fetch (CLIENT_TRACE_JS). The front door validates it, records the two ids on the
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

const hex = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, "0")).join("")
const HEX16 = /^[0-9a-f]{16}$/

/** The page routes (/, /instrument) carry trace context too (OTel document-load convention). The document's trace id is the
 *  incoming traceparent's (adopted: Effect's HttpMiddleware.tracer already parents the root span on it) or a fresh one; its
 *  span id is the root Effect request span's own id (`effect.span_id` on that Workers span), so the page's fetch spans are
 *  its children. Recorded on the root span: `client.trace_id`, `client.document_span_id`, `client.trace_origin`
 *  (`adopted` | `minted`; with `client.span_id` = the incoming parent when adopted). Returned to the page as
 *  `<meta name="traceparent">` (read first by CLIENT_TRACE_JS), `Server-Timing: trace;desc="<traceparent>"` (the navigation
 *  entry's serverTiming) and `x-ephem-trace` (curl, CDP). Call it outside the handler's own withSpan, so the current span is
 *  the root request span. The HTML is `private, no-store` and never forwarded to the cached Api, so a per-response id is safe. */
export const documentTrace = (req: HttpServerRequest.HttpServerRequest) => Effect.gen(function* () {
  const tp = parseTraceparent(req.headers["traceparent"])
  const span = yield* Effect.option(Effect.currentSpan)
  const cur = span._tag === "Some" ? span.value : undefined
  // Minted here, never taken from Effect's span: its own parser accepts header values that W3C rejects (a malformed
  // traceparent still parents the Effect span), and only a strictly valid incoming id is ever adopted.
  const traceId = tp?.traceId ?? hex(16)
  const spanId = cur && HEX16.test(cur.spanId) ? cur.spanId : hex(8)
  yield* Effect.annotateCurrentSpan({ "client.trace_id": traceId, "client.document_span_id": spanId, "client.trace_origin": tp ? "adopted" : "minted" })
  return { traceId, spanId, traceparent: `00-${traceId}-${spanId}-01` }
})
export type DocumentTrace = { readonly traceId: string; readonly spanId: string; readonly traceparent: string }
/** Response headers of a page: the id for CDP, curl and the navigation entry's serverTiming. */
export const documentTraceHeaders = (d: DocumentTrace): Record<string, string> =>
  ({ [TRACE_HEADER]: d.traceId, "server-timing": `trace;desc="${d.traceparent}"` })
/** `<meta name="traceparent">` for the page's head; built only from validated hex, anything else renders nothing. */
export const traceparentMeta = (d: DocumentTrace | undefined): string =>
  d && parseTraceparent(d.traceparent) ? `<meta name="traceparent" content="${d.traceparent}">` : ""

export const ClientTrace = HttpRouter.middleware(Effect.gen(function* () {
  const edge = yield* Edge
  return http => Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    const tp = parseTraceparent(req.headers["traceparent"])
    if (!tp) return yield* http
    yield* Effect.annotateCurrentSpan({ "client.trace_id": tp.traceId, "client.span_id": tp.spanId })
    const res = yield* http
    // The Api's answers are cached by Workers Caching: an echo there would be replayed to other clients.
    return edge.role === "api" ? res : HttpServerResponse.setHeader(res, TRACE_HEADER, tp.traceId)
  })
}), { global: true })

/** Browser side, inlined in both pages: `__tfetch(url, init)` = fetch with a traceparent. `window.__ephemTrace` =
 *  { traceId, parentSpanId (the document's span), from (meta | server-timing | fresh), fetches: [{ spanId, parent, url, t0, t1, status, ray, echo }] } (ms since navigation start) for scripts/obs/journey.ts. */
export const CLIENT_TRACE_JS = String.raw`
var __ephemTrace = window.__ephemTrace = (function () {
  function hex(n) { var b = new Uint8Array(n); crypto.getRandomValues(b); var s = ""; for (var i = 0; i < n; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16); return s; }
  var RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/, m = null, from = "fresh";
  try { var el = document.querySelector('meta[name="traceparent"]'); if (el) { m = RE.exec(el.getAttribute("content") || ""); if (m) from = "meta"; } } catch (e) {}
  if (!m) try {
    var nav = performance.getEntriesByType("navigation")[0], st = nav && nav.serverTiming || [];
    for (var i = 0; i < st.length && !m; i++) if (st[i].name === "trace") { m = RE.exec(st[i].description || ""); if (m) from = "server-timing"; }
  } catch (e) {}
  if (m && (/^0+$/.test(m[1]) || /^0+$/.test(m[2]))) { m = null; from = "fresh"; }
  return { traceId: m ? m[1] : hex(16), parentSpanId: m ? m[2] : null, from: from, fetches: [], hex: hex };
})();
function __tfetch(url, init) {
  var T = __ephemTrace, sid = T.hex(8), rec = { spanId: sid, parent: T.parentSpanId, url: String(url), t0: performance.now(), t1: null, status: null, ray: null, echo: null };
  T.fetches.push(rec);
  init = init || {}; var h = new Headers(init.headers || {}); h.set("traceparent", "00-" + T.traceId + "-" + sid + "-01"); init.headers = h;
  return fetch(url, init).then(function (r) {
    rec.t1 = performance.now(); rec.status = r.status; rec.ray = r.headers.get("cf-ray"); rec.echo = r.headers.get("x-ephem-trace");
    return r;
  }, function (e) { rec.t1 = performance.now(); rec.status = 0; throw e; });
}
`
