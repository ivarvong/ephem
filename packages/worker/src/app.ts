// Assemble the front door's HTTP app: the shared router (src/router.ts) plus the homepage, docs,
// /openapi.json and MCP.
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { EphemApi } from "@ephem/api"
import type { Blocks } from "./blocks.ts"
import { GeoidInstalled, type Geoid } from "./geoid.ts"
import { TracerLive } from "./trace.ts"
import { Gateway, type Role } from "./responses.ts"
import { Home } from "./home.ts"
import { SkyAssets } from "./sky-assets.ts"
import { WeatherNone, type Weather } from "./weather.ts"
import { Mcp } from "./mcp.ts"
import { docsCsp, scalarCsp } from "@ephem/web/server"
import { docsHtml, llmsTxt, scalarHtml } from "./docs.ts"
import { pageHeaders } from "./home.ts"
import { RequestLogging } from "./requestlog.ts"
import { ClientTrace } from "./clienttrace.ts"
import { Rum } from "./rum.ts"
import { Cors, provideApp, toHandler } from "./router.ts"

/** /docs (plain HTML), /llms.txt and /docs/interactive (Scalar from jsDelivr, ~0 bundle cost): src/docs.ts, rendered by @ephem/web. */
let docsPages: { html: string; scalar: string; llms: string } | undefined
const pages = () => (docsPages ??= { html: docsHtml(), scalar: scalarHtml(), llms: llmsTxt() })
const Docs = Layer.mergeAll(
  HttpRouter.add("GET", "/docs", Effect.sync(() => HttpServerResponse.text(pages().html, { contentType: "text/html; charset=utf-8", headers: pageHeaders(docsCsp()) }))),
  HttpRouter.add("GET", "/docs/interactive", Effect.sync(() => HttpServerResponse.text(pages().scalar, { contentType: "text/html; charset=utf-8", headers: pageHeaders(scalarCsp()) }))),
  HttpRouter.add("GET", "/llms.txt", Effect.sync(() => HttpServerResponse.text(pages().llms, { contentType: "text/plain; charset=utf-8" }))),
)

/** `edge`: which side of the front door → Api loopback this router is (src/responses.ts); default `local` (tests, dev).
 *  `geoid`: the Worker passes makeGeoid (R2 bands via BlockStore); the default relies on a band source the caller installed. */
export const makeApp = (blocks: Layer.Layer<Blocks>, edge: Role = { role: "local" }, weather: Layer.Layer<Weather> = WeatherNone, geoid: Layer.Layer<Geoid> = GeoidInstalled) =>
  provideApp(Layer.mergeAll(
    HttpApiBuilder.layer(EphemApi, { openapiPath: "/openapi.json" }),
    Home,
    SkyAssets,   // /assets/de440/<sha16>/<i>: the page's in-browser compute reads DE440 blocks (src/sky-assets.ts)
    Rum,   // POST /rum: browser RUM batches → Basin ephem_rum (src/rum.ts)
    Docs,
    RequestLogging,   // first global middleware = outermost: it sees every request, including those Gateway forwards
    Cors,
    ClientTrace,   // traceparent → client.trace_id / client.span_id on the root span, x-ephem-trace echo (src/clienttrace.ts)
    Gateway,
    Mcp,
    TracerLive,
  ), blocks, edge, weather, geoid)

export const makeHandler = (blocks: Layer.Layer<Blocks>, edge?: Role, weather?: Layer.Layer<Weather>, geoid?: Layer.Layer<Geoid>) => toHandler(makeApp(blocks, edge, weather, geoid))
