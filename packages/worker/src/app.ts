// Assemble the HTTP app from the contract, the handlers, and a Blocks implementation; expose a fetch-style handler.
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as HttpApiError from "effect/http-api/HttpApiError"
import { EphemApi, QUERY_PARAMS } from "@ephem/api"
import { HandlersLive } from "./handlers.ts"
import type { Blocks } from "./blocks.ts"
import { GeoidInstalled, type Geoid } from "./geoid.ts"
import { TracerLive } from "./trace.ts"
import { Edge, Gateway, type Role } from "./responses.ts"
import { Home } from "./home.ts"
import { WeatherNone, type Weather } from "./weather.ts"
import { Mcp } from "./mcp.ts"
import { SCALAR_HTML, docsHtml, llmsTxt } from "./docs.ts"
import { RequestLog, RequestLogging, type RequestLogSink } from "./requestlog.ts"

// No HttpPlatform / FileSystem / Path / Etag layers (HttpServer.layerServices): only file responses and on-disk multipart
// need them, and nothing here serves files. Providing them kept mime tables, Path and FileSystem in the bundle (2026-10-30).

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

/** /docs (plain HTML), /llms.txt and /docs/interactive (Scalar from jsDelivr, ~0 bundle cost): src/docs.ts. */
let docsPages: { html: string; llms: string } | undefined
const pages = () => (docsPages ??= { html: docsHtml(), llms: llmsTxt() })
const Docs = Layer.mergeAll(
  HttpRouter.add("GET", "/docs", Effect.sync(() => HttpServerResponse.html(pages().html))),
  HttpRouter.add("GET", "/docs/interactive", HttpServerResponse.html(SCALAR_HTML)),
  HttpRouter.add("GET", "/llms.txt", Effect.sync(() => HttpServerResponse.text(pages().llms, { contentType: "text/plain; charset=utf-8" }))),
)

/** `edge`: which side of the front door → Api loopback this router is (src/responses.ts); default `local` (tests, dev).
 *  `geoid`: the Worker passes makeGeoid (R2 bands via BlockStore); the default relies on a band source the caller installed. */
export const makeApp = (blocks: Layer.Layer<Blocks>, edge: Role = { role: "local" }, weather: Layer.Layer<Weather> = WeatherNone, geoid: Layer.Layer<Geoid> = GeoidInstalled) =>
  Layer.mergeAll(
    HttpApiBuilder.layer(EphemApi, { openapiPath: "/openapi.json" }),
    Home,
    Docs,
    RequestLogging,   // first global middleware = outermost: it sees every request, including those Gateway forwards
    Cors,
    Gateway,
    Mcp,
    TracerLive,
  ).pipe(Layer.provide(ExplainSchemaErrors.layer), Layer.provide(HandlersLive), Layer.provide(weather), Layer.provide(blocks), Layer.provide(geoid), Layer.provide(Layer.succeed(Edge, edge)))

export const makeHandler = (blocks: Layer.Layer<Blocks>, edge?: Role, weather?: Layer.Layer<Weather>, geoid?: Layer.Layer<Geoid>) => {
  const { handler } = HttpRouter.toWebHandler(makeApp(blocks, edge, weather, geoid) as Layer.Layer<never, never, HttpRouter.HttpRouter>, { disableLogger: true })
  /** `log`: where this request's Basin row goes (src/requestlog.ts); without it nothing is logged. */
  return async (request: Request, log?: RequestLogSink): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "*" } })
    const t0 = performance.now()
    const res = await handler(request, log ? Context.make(RequestLog, log) : undefined)
    const h = new Headers(res.headers); h.set("server-timing", `total;dur=${(performance.now() - t0).toFixed(1)}`)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
  }
}
