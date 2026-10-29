// Cloudflare Worker entry. Workers Caching only (no Cache API); which entrypoints are cached is cloudflare.config.ts `exports`.
//   default     cache OFF. The front door: always runs (traces, logs, request.cf, `/`, `/mcp`); GET /v1/* is forwarded to Api.
//   Api         cache ON.  The same router; sets the internal Cache-Control per route (src/responses.ts).
//   BlockStore  cache ON.  GET /de440/<sha>/<i> → one DE440 block from an R2 range read, immutable.
//   MetarFeed   cache ON.  GET /feed/metars.cache.csv.gz → aviationweather.gov's feed, max-age + SWR + stale-if-error.
// Blocks: L1 isolate LRU → ctx.exports.BlockStore (Workers Caching lower/upper tier → R2). Weather: L1 parsed table →
// ctx.exports.MetarFeed (Workers Caching → upstream).
import { WorkerEntrypoint, tracing } from "cloudflare:workers"
import { makeHandler } from "./app.ts"
import { loopbackBlocks, makeBlocks, r2Origin, serveBlock, type R2BucketLike } from "./blocks.ts"
import { setTracing } from "./trace.ts"
import { defaultNoStore } from "./responses.ts"
import { makeFeed, serveFeed } from "./metar-feed.ts"
import { weatherLive } from "./weather.ts"
import { pipelineSink, type PipelineLike, type RequestRow } from "./requestlog.ts"
export { Admin } from "./admin.ts"

// LOGS: Basin stream ephem_requests (one row per request, src/requestlog.ts); VERSION: this Worker version's id for the row;
// REQUEST_LOGS: "off" disables rows (the logging-overhead A/B).
interface Env { readonly EPH: R2BucketLike; readonly LOGS?: PipelineLike<RequestRow>; readonly VERSION?: { readonly id: string }; readonly REQUEST_LOGS?: string }
const logs = (env: Env, waitUntil: (p: Promise<unknown>) => void, role: string) =>
  env.LOGS && env.REQUEST_LOGS !== "off" ? pipelineSink(env.LOGS, waitUntil, env.VERSION?.id, role) : undefined
type Loopback = { fetch(req: Request, init?: { cf?: { cacheKey: string } }): Promise<Response> }
interface Ctx { waitUntil(p: Promise<unknown>): void; readonly exports: Record<string, Loopback> }

declare const __EPHEM_BUILD__: string   // per build (wrangler.config.ts); partitions the Api's cache under crossVersionCache
const BUILD = typeof __EPHEM_BUILD__ === "string" ? __EPHEM_BUILD__ : "dev"
setTracing(tracing)
// ctx.exports of the invocation in flight. The loopback bindings are the same objects for every invocation of this isolate.
let loop: Record<string, Loopback> | undefined
const exported = (name: string) => () => { const b = loop?.[name]; if (!b) throw new Error(`ctx.exports.${name} unavailable`); return b }

// One Blocks L1 and one parsed METAR table per isolate, shared by both routers.
const blocks = makeBlocks(loopbackBlocks(exported("BlockStore")))
const weather = weatherLive(makeFeed({ fetch: req => exported("MetarFeed")().fetch(req) }))
let front: ReturnType<typeof makeHandler> | undefined
let api: ReturnType<typeof makeHandler> | undefined

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    loop = ctx.exports
    front ??= makeHandler(blocks, { role: "front", api: (req, init) => exported("Api")().fetch(req, init), keyPrefix: `/${BUILD}` }, weather)
    return front(request, logs(env, p => ctx.waitUntil(p), "front"))
  },
}

export class Api extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    loop = this.ctx.exports
    api ??= makeHandler(blocks, { role: "api" }, weather)
    return defaultNoStore(await api(request, logs(this.env, p => this.ctx.waitUntil(p), "api")))
  }
}

export class BlockStore extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> { return serveBlock(request, r2Origin(this.env.EPH)) }
}

export class MetarFeed extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> { return serveFeed(request, { fetch: (u, i) => fetch(u, i) }) }
}
