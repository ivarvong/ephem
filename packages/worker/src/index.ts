// ephem: the front door. Workers Caching only (no Cache API); which entrypoints are cached is cloudflare.config.ts `exports`.
//   default     cache OFF. Always runs (traces, logs, request.cf, `/`, `/mcp`, live position / magnetic, weather, the
//               alignment/search merge); every deterministic GET /v1/* is forwarded to ephem-compute's Api.
//   MetarFeed   cache ON.  GET /feed/v<N>/metars.cache.csv.gz → aviationweather.gov's feed, max-age + SWR + stale-if-error.
//   Admin       RPC only (ingest).
// ephem-compute (src/compute.ts, packages/compute) holds the CPU-heavy cache-enabled entrypoints, Api and BlockStore, in its
// own isolate pool, so window/alignment/day/track misses never make the platform spawn front-door isolates (guide
// "Compute split"). The front door reaches them over service bindings (env.COMPUTE, env.STORE): Workers Caching of the
// callee applies to those fetches as to ctx.exports. Live routes' blocks: L1 isolate LRU → STORE (ephem-compute's cache
// → R2). Weather: L1 parsed table → MetarFeed loopback. All loopbacks: src/loopback.ts; cache tag: src/cache-version.ts.
import { WorkerEntrypoint, tracing } from "cloudflare:workers"
import { makeHandler } from "./app.ts"
import { loopbackBlocks, makeBlocks } from "./blocks.ts"
import { setTracing } from "./trace.ts"
import { loopbackGeoid, makeGeoid } from "./geoid.ts"
import { makeLoopback, resolveBindings, type Binding, type Bindings, type ComputeBindings } from "./loopback.ts"
import { makeFeed, serveFeed } from "./metar-feed.ts"
import { weatherLive } from "./weather.ts"
import { pipelineSink, type PipelineLike, type RequestRow } from "./requestlog.ts"
export { Admin } from "./admin.ts"

// LOGS: Basin stream ephem_requests (one row per request, src/requestlog.ts); VERSION: this Worker version's id for the row;
// REQUEST_LOGS: "off" disables rows (the logging-overhead A/B). COMPUTE / STORE: service bindings to ephem-compute's Api / BlockStore.
interface Env extends ComputeBindings { readonly COMPUTE: Binding; readonly STORE: Binding; readonly LOGS?: PipelineLike<RequestRow>; readonly VERSION?: { readonly id: string }; readonly REQUEST_LOGS?: string }
interface Ctx { waitUntil(p: Promise<unknown>): void; readonly exports: Bindings }

setTracing(tracing)
// ctx.exports and env of the invocation in flight. The bindings are the same objects for every invocation of this isolate.
let loop: Bindings | undefined
let bound: ComputeBindings | undefined
const lb = makeLoopback(() => resolveBindings(loop, bound))   // every loopback fetch goes through src/loopback.ts (test/loopback.test.ts)

// One Blocks L1 and one parsed METAR table per isolate.
const blocks = makeBlocks(loopbackBlocks(lb.block))
const geoid = makeGeoid(loopbackGeoid(lb.geoid))
const weather = weatherLive(makeFeed({ fetch: () => lb.feed() }))
let front: ReturnType<typeof makeHandler> | undefined

// x-ephem-version: the front door's Worker version id on every response, so scripts/smoke.sh can prove a version-pinned
// request (Cloudflare-Workers-Version-Overrides) reached the version it pinned, and a rollback is visible per request.
// (x-ephem-compute-version, relayed from ephem-compute on forwarded answers, names the compute version that computed it.)
const withVersion = (r: Response, id: string | undefined): Response => {
  if (!id) return r
  try { r.headers.set("x-ephem-version", id); return r } catch { const c = new Response(r.body, r); c.headers.set("x-ephem-version", id); return c }
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    loop = ctx.exports; bound = env
    front ??= makeHandler(blocks, { role: "front", api: lb.api }, weather, geoid)
    return withVersion(await front(request, logs(env, p => ctx.waitUntil(p), "front")), env.VERSION?.id)
  },
}
const logs = (env: Env, waitUntil: (p: Promise<unknown>) => void, role: string) =>
  env.LOGS && env.REQUEST_LOGS !== "off" ? pipelineSink(env.LOGS, waitUntil, env.VERSION?.id, role) : undefined

export class MetarFeed extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> { return serveFeed(request, { fetch: (u, i) => fetch(u, i) }) }
}
