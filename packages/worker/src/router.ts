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
import { EphemApi, INTERNAL_QUERY_PARAMS, QUERY_PARAMS, SearchPayload, paramDoc } from "@ephem/api"
import { HandlersLive } from "./handlers.ts"
import { SearchLive } from "./search.ts"
import type { Blocks } from "./blocks.ts"
import { GeoidInstalled, type Geoid } from "./geoid.ts"
import { TracerLive } from "./trace.ts"
import { Edge, Gateway, notFound, type Role } from "./responses.ts"
import { WeatherNone, type Weather } from "./weather.ts"
import { RequestLog, RequestLogging, type RequestLogSink } from "./requestlog.ts"
import { ClientTrace } from "./clienttrace.ts"
import { RumSink, type RumSinkI } from "./rum.ts"

// No HttpPlatform / FileSystem / Path / Etag layers (HttpServer.layerServices): only file responses and on-disk multipart
// need them, and nothing here serves files. Providing them kept mime tables, Path and FileSystem in the bundle (2026-10-30).

/** CORS + Server-Timing on every response: the API is meant to be called from browsers and compared across deployments. */
// timing-allow-origin: cross-origin callers' Resource Timing may read the full timing and serverTiming (only ids, cache statuses
// and I/O durations; src/servertiming.ts). access-control-expose-headers: the trace id and version for cross-origin fetch().
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "*", "access-control-max-age": "86400",
  "timing-allow-origin": "*", "access-control-expose-headers": "server-timing, x-ephem-trace, x-ephem-version, x-ephem-cache" } as const
export const Cors = HttpRouter.middleware(http => Effect.map(http, HttpServerResponse.setHeaders(CORS)), { global: true })

/** Names this API used before 2026-10-31 (docs/API.md "What changes"), so an old URL's 400 says what to use instead. */
const RENAMED: Readonly<Record<string, string>> = { observerHeight: "height", observerLat: "lat", observerLon: "lon", limb: "aim", n: "count" }
const editDistance = (a: string, b: string) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0]![j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1]!.toLowerCase() === b[j - 1]!.toLowerCase() ? 0 : 1))
  return d[a.length]![b.length]!
}
/** "did you mean" for an unknown parameter: a renamed one, or an allowed name within 2 edits. */
export const suggest = (name: string, allowed: ReadonlyArray<string>): string | undefined => {
  const r = RENAMED[name]; if (r && allowed.includes(r)) return r
  const best = allowed.map(a => [a, editDistance(name, a)] as const).toSorted((x, y) => x[1] - y[1])[0]
  return best && best[1] <= 2 ? best[0] : undefined
}

/** A schema issue ("Expected a value between -90 and 90\n  at [\"lat\"]") → which parameter, what was wrong, what is allowed. */
export const explainIssue = (path: string, raw: string, value: (name: string) => string | null | undefined) => {
  const issue = raw.split("\n")[0]!.trim(), at = /\n\s*at ((?:\[[^\]]*\])+)\s*$/.exec(raw)
  let keys: Array<string | number> = []
  try { keys = at ? [...at[1]!.matchAll(/\[([^\]]*)\]/g)].map(m => JSON.parse(m[1]!) as string | number) : [] } catch { keys = [] }
  const parameter = typeof keys[0] === "string" ? keys[0] : undefined
  if (parameter === undefined) return { message: issue } as { message: string; parameter?: string; allowed?: string[] }
  const doc = paramDoc(path, parameter), nested = keys.length > 1 ? `${keys.slice(1).map(k => (typeof k === "number" ? `[${k}]` : `.${k}`)).join("")}` : ""
  const choices = /^Expected ("[^"]*"(?: \| "[^"]*")*)$/.exec(issue)?.[1]?.split(" | ").map(x => JSON.parse(x) as string)
  const v = value(parameter)
  const what = nested ? `${parameter} is not valid (at ${parameter}${nested}: ${issue})`
    : issue === "Missing key" ? `missing required parameter ${parameter}`
    : v !== undefined && v !== null ? `${parameter}=${v} is not valid` : `${parameter} is not valid (${issue})`
  return { parameter, message: doc ? `${what}: ${doc}` : what, ...(choices ? { allowed: choices } : {}) }
}

/** Request-decoding failures become a 400 InvalidRequest naming the parameter, what was wrong and what is allowed, instead
 *  of the runtime's empty 400. Unknown query parameters (rejected by the contract's QueryParseOptions) are named, with the
 *  allowed set for the path and a "did you mean" (renamed or misspelled). */
export const ExplainSchemaErrors = HttpRouter.middleware(http => Effect.catchDefect(http, defect =>
  HttpApiError.HttpApiSchemaError.is(defect)
    ? Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan("ephem.error_tag", "InvalidRequest")
      const req = yield* HttpServerRequest.HttpServerRequest, url = new URL(req.originalUrl, "http://x"), allowed = QUERY_PARAMS[url.pathname] ?? INTERNAL_QUERY_PARAMS[url.pathname]
      const unknown = defect.kind === "Query" && allowed ? [...new Set(url.searchParams.keys())].filter(k => !allowed.includes(k)) : []
      if (unknown.length) {
        const hints = unknown.map(k => { const s = suggest(k, allowed!); return s ? ` (${k}: did you mean ${s}?)` : "" }).join("")
        return HttpServerResponse.jsonUnsafe({ _tag: "InvalidRequest", parameter: unknown[0],
          message: `unknown parameter${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")} for ${url.pathname}${hints}; allowed: ${allowed!.join(", ")}`, allowed }, { status: 400 })
      }
      const raw = String(defect.cause.message ?? defect.cause)
      yield* Effect.annotateCurrentSpan("ephem.schema_issue", raw.slice(0, 500))
      const e = explainIssue(url.pathname, raw, name => (defect.kind === "Query" ? url.searchParams.get(name) : undefined))
      if (defect.kind !== "Query" && /unexpected|excess/i.test(raw) && e.parameter) {
        const fields = Object.keys(SearchPayload.fields), s = suggest(e.parameter, fields)
        return HttpServerResponse.jsonUnsafe({ _tag: "InvalidRequest", parameter: e.parameter, message: `unknown field ${e.parameter} in the ${url.pathname} body${s ? ` (did you mean ${s}?)` : ""}; allowed: ${fields.join(", ")}`, allowed: fields }, { status: 400 })
      }
      return HttpServerResponse.jsonUnsafe({ _tag: "InvalidRequest", ...e }, { status: 400 })
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
  return async (request: Request, log?: RequestLogSink, rum?: RumSinkI): Promise<Response> => {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "*" } })
    const t0 = performance.now()
    const ctx = log && rum ? Context.add(Context.make(RequestLog, log), RumSink, rum) : log ? Context.make(RequestLog, log) : rum ? Context.make(RumSink, rum) : undefined
    let res = await handler(request, ctx as Context.Context<never> | undefined)
    if (res.status === 404 && !res.headers.get("content-type")) res = HttpServerResponse.toWeb(notFound(new URL(request.url)))   // the router's own empty 404
    const h = new Headers(res.headers); const st = res.headers.get("server-timing")   // the router's entries (src/servertiming.ts), then the request's I/O wall
    h.set("server-timing", (st ? st + ", " : "") + `total;dur=${(performance.now() - t0).toFixed(1)}`)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
  }
}

export const makeApiHandler = (blocks: Layer.Layer<Blocks>, edge?: Role, weather?: Layer.Layer<Weather>, geoid?: Layer.Layer<Geoid>) => toHandler(makeApiApp(blocks, edge, weather, geoid))
