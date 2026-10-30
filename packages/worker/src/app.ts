// Assemble the front door's HTTP app: the shared router (src/router.ts) plus the homepage, docs, /openapi.json and MCP.
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
import { WeatherNone, type Weather } from "./weather.ts"
import { Mcp } from "./mcp.ts"
import { SCALAR_HTML, docsHtml, llmsTxt } from "./docs.ts"
import { RequestLogging } from "./requestlog.ts"
import { Cors, provideApp, toHandler } from "./router.ts"

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
  provideApp(Layer.mergeAll(
    HttpApiBuilder.layer(EphemApi, { openapiPath: "/openapi.json" }),
    Home,
    Docs,
    RequestLogging,   // first global middleware = outermost: it sees every request, including those Gateway forwards
    Cors,
    Gateway,
    Mcp,
    TracerLive,
  ), blocks, edge, weather, geoid)

export const makeHandler = (blocks: Layer.Layer<Blocks>, edge?: Role, weather?: Layer.Layer<Weather>, geoid?: Layer.Layer<Geoid>) => toHandler(makeApp(blocks, edge, weather, geoid))
