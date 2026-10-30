// The HTTP router minus the front door's pages. The Api entrypoint (src/compute.ts) runs makeApiHandler: the EphemApi routes
// only, no homepage, docs or MCP. The front door runs makeApp (src/app.ts) = this plus Home, Docs and Mcp.
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
import { SearchLive } from "./search.ts"
import type { Blocks } from "./blocks.ts"
import { GeoidInstalled, type Geoid } from "./geoid.ts"
import { TracerLive } from "./trace.ts"
import { Edge, Gateway, type Role } from "./responses.ts"
import { WeatherNone, type Weather } from "./weather.ts"
import { RequestLog, RequestLogging, type RequestLogSink } from "./requestlog.ts"
import { ClientTrace } from "./clienttrace.ts"

// No HttpPlatform / FileSystem / Path / Etag layers (HttpServer.layerServices): only file responses and on-disk multipart
// need them, and nothing here serves files. Providing them kept mime tables, Path and FileSystem in the bundle (2026-10-30).

/** CORS + Server-Timing on every response: the API is meant to be called from browsers and compared across deployments. */
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "*", "access-control-max-age": "86400" } as const
export const Cors = HttpRouter.middleware(http => Effect.map(http, HttpServerResponse.setHeaders(CORS)), { global: true })

/** Request-decoding failures become a 400 with the issue spelled out, instead of the runtime's empty 400. */
/** Unknown query parameters (rejected by the contract's QueryParseOptions) are named, with the allowed set for the path. */
export const ExplainSchemaErrors = HttpRouter.middleware(http => Effect.catchDefect(http, defect =>
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

/** Handlers, weather, blocks, geoid and the Edge role, provided to a router layer. */
export const provideApp = <A, E, R>(app: Layer.Layer<A, E, R>, blocks: Layer.Layer<Blocks>, edge: Role, weather: Layer.Layer<Weather>, geoid: Layer.Layer<Geoid>) =>
  app.pipe(Layer.provide(ExplainSchemaErrors.layer), Layer.provide(Layer.mergeAll(HandlersLive, SearchLive)), Layer.provide(weather), Layer.provide(blocks), Layer.provide(geoid), Layer.provide(Layer.succeed(Edge, edge)))

/** The Api entrypoint: the /v1 routes only (no openapi.json, homepage, docs or MCP). */
export const makeApiApp = (blocks: Layer.Layer<Blocks>, edge: Role = { role: "api" }, weather: Layer.Layer<Weather> = WeatherNone, geoid: Layer.Layer<Geoid> = GeoidInstalled) =>
  provideApp(Layer.mergeAll(HttpApiBuilder.layer(EphemApi), RequestLogging, Cors, ClientTrace, Gateway, TracerLive), blocks, edge, weather, geoid)

/** A router layer as a fetch-style handler. `log`: where this request's Basin row goes (src/requestlog.ts); without it nothing is logged. */
export const toHandler = (app: unknown) => {
  const { handler } = HttpRouter.toWebHandler(app as Layer.Layer<never, never, HttpRouter.HttpRouter>, { disableLogger: true })
  return async (request: Request, log?: RequestLogSink): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "*" } })
    const t0 = performance.now()
    const res = await handler(request, log ? Context.make(RequestLog, log) : undefined)
    const h = new Headers(res.headers); const tr = res.headers.get("server-timing")   // a page's `trace;desc=…` entry (src/clienttrace.ts) stays; anything else is replaced
    h.set("server-timing", (tr?.startsWith("trace;") ? tr + ", " : "") + `total;dur=${(performance.now() - t0).toFixed(1)}`)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
  }
}

export const makeApiHandler = (blocks: Layer.Layer<Blocks>, edge?: Role, weather?: Layer.Layer<Weather>, geoid?: Layer.Layer<Geoid>) => toHandler(makeApiApp(blocks, edge, weather, geoid))
