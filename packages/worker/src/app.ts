// Assemble the HTTP app from the contract, the handlers, and a Blocks implementation; expose a fetch-style handler.
import { Context, Effect, FileSystem, Layer, Path } from "effect"
import { Etag, HttpPlatform, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { HttpApiBuilder, HttpApiError } from "effect/http-api"
import { EphemApi, QUERY_PARAMS } from "@ephem/api"
import { HandlersLive } from "./handlers.ts"
import type { Blocks } from "./blocks.ts"
import { TracerLive } from "./trace.ts"
import { Edge, Gateway, type Role } from "./responses.ts"
import { Home } from "./home.ts"
import { WeatherNone, type Weather } from "./weather.ts"
import { Mcp } from "./mcp.ts"
import { RequestLog, RequestLogging, type RequestLogSink } from "./requestlog.ts"

const PlatformWeb = Layer.mergeAll(HttpPlatform.layer, FileSystem.layerNoop({}), Path.layer, Etag.layerWeak).pipe(Layer.provideMerge(FileSystem.layerNoop({})))

/** CORS + Server-Timing on every response: the API is meant to be called from browsers and compared across deployments. */
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "*", "access-control-max-age": "86400" } as const
const Cors = HttpRouter.middleware(http => Effect.map(http, HttpServerResponse.setHeaders(CORS)), { global: true })

/** Request-decoding failures become a 400 with the issue spelled out, instead of the runtime's empty 400. */
/** Unknown query parameters (rejected by the contract's QueryParseOptions) are named, with the allowed set for the path. */
const ExplainSchemaErrors = HttpRouter.middleware(http => Effect.catchDefect(http, defect =>
  HttpApiError.HttpApiSchemaError.is(defect)
    ? Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan("ephem.error_tag", "InvalidRequest")
      const req = yield* HttpServerRequest.HttpServerRequest, url = new URL(req.originalUrl, "http://x"), allowed = QUERY_PARAMS[url.pathname]
      const unknown = defect.kind === "Query" && allowed ? [...new Set(url.searchParams.keys())].filter(k => !allowed.includes(k)) : []
      return unknown.length
        ? HttpServerResponse.jsonUnsafe({ _tag: "InvalidRequest", kind: "UnknownParameter", message: `unknown query parameter${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} for ${url.pathname}; allowed: ${allowed!.join(", ")}`, unknown, allowed }, { status: 400 })
        : HttpServerResponse.jsonUnsafe({ _tag: "InvalidRequest", kind: defect.kind, message: String(defect.cause.message ?? defect.cause) }, { status: 400 })
    })
    : Effect.die(defect)))

/** /docs: a few hundred bytes of HTML that loads a pinned Scalar from jsDelivr. HttpApiScalar.layerCdn inlines a
 *  ~3 MB bundle into the Worker, which was 73% of the script; this keeps the same page at ~0 bundle cost. */
export const SCALAR = "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.74.0"
const DOCS_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ephem API</title></head><body><script id="api-reference" data-url="/openapi.json"></script><script src="${SCALAR}"></script></body></html>`
const Docs = HttpRouter.add("GET", "/docs", HttpServerResponse.html(DOCS_HTML))

/** `edge`: which side of the front door → Api loopback this router is (src/responses.ts); default `local` (tests, dev). */
export const makeApp = (blocks: Layer.Layer<Blocks>, edge: Role = { role: "local" }, weather: Layer.Layer<Weather> = WeatherNone) =>
  Layer.mergeAll(
    HttpApiBuilder.layer(EphemApi, { openapiPath: "/openapi.json" }),
    Home,
    Docs,
    RequestLogging,   // first global middleware = outermost: it sees every request, including those Gateway forwards
    Cors,
    Gateway,
    Mcp,
    TracerLive,
  ).pipe(Layer.provide(ExplainSchemaErrors.layer), Layer.provide(HandlersLive), Layer.provide(weather), Layer.provide(blocks), Layer.provide(Layer.succeed(Edge, edge)), Layer.provide(PlatformWeb))

export const makeHandler = (blocks: Layer.Layer<Blocks>, edge?: Role, weather?: Layer.Layer<Weather>) => {
  const { handler } = HttpRouter.toWebHandler(makeApp(blocks, edge, weather) as Layer.Layer<never, never, HttpRouter.HttpRouter>, { disableLogger: true })
  /** `log`: where this request's Basin row goes (src/requestlog.ts); without it nothing is logged. */
  return async (request: Request, log?: RequestLogSink): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "*" } })
    const t0 = performance.now()
    const res = await handler(request, log ? Context.make(RequestLog, log) : undefined)
    const h = new Headers(res.headers); h.set("server-timing", `total;dur=${(performance.now() - t0).toFixed(1)}`)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
  }
}
