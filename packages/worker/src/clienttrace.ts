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
 *  { traceId, fetches: [{ spanId, url, t0, t1, status, ray, echo }] } (ms since navigation start) for scripts/obs/journey.ts. */
export const CLIENT_TRACE_JS = String.raw`
var __ephemTrace = window.__ephemTrace = (function () {
  function hex(n) { var b = new Uint8Array(n); crypto.getRandomValues(b); var s = ""; for (var i = 0; i < n; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16); return s; }
  return { traceId: hex(16), fetches: [], hex: hex };
})();
function __tfetch(url, init) {
  var T = __ephemTrace, sid = T.hex(8), rec = { spanId: sid, url: String(url), t0: performance.now(), t1: null, status: null, ray: null, echo: null };
  T.fetches.push(rec);
  init = init || {}; var h = new Headers(init.headers || {}); h.set("traceparent", "00-" + T.traceId + "-" + sid + "-01"); init.headers = h;
  return fetch(url, init).then(function (r) {
    rec.t1 = performance.now(); rec.status = r.status; rec.ray = r.headers.get("cf-ray"); rec.echo = r.headers.get("x-ephem-trace");
    return r;
  }, function (e) { rec.t1 = performance.now(); rec.status = 0; throw e; });
}
`
