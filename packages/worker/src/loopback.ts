// The one way to call our own cache-enabled entrypoints, in this Worker (ctx.exports) or in ephem-compute (service
// bindings); test/loopback.test.ts fails if any ctx.exports or COMPUTE / STORE fetch bypasses it.
//   ephem (front door)  Api → env.COMPUTE (ephem-compute's Api)  · BlockStore → env.STORE (ephem-compute's BlockStore)
//                       MetarFeed → ctx.exports.MetarFeed (ephem's own)
//   ephem-compute       BlockStore → ctx.exports.BlockStore (same Worker, same version as the calling Api invocation)
// A service-binding fetch is cached by the callee exactly like a ctx.exports fetch: the callee's Workers Caching is
// consulted first, and cf.cacheKey is honoured for same-account calls (docs: workers/cache "Caching between Workers",
// cache-keys "Custom keys apply to same-account calls only"; verified live, guide "Compute split").
// crossVersionCache is on in both Workers, so an entry is shared by every deployed version; the only partition is the
// cache tag in each key (src/cache-version.ts):
//   Api         cf.cacheKey = /v<N>/<path?sorted query>
//   BlockStore  /block/v<N>/<sha16>/<i>   (blocks.ts blockPath) · /geoid/v<N>/<sha16>/<band>   (geoid.ts geoidPath)
//   MetarFeed   /feed/v<N>/metars.cache.csv.gz   (metar-feed.ts FEED_PATH)
import { CACHE_TAG } from "./cache-version.ts"
import { blockPath } from "./blocks.ts"
import { geoidPath } from "./geoid.ts"
import { FEED_PATH } from "./metar-feed.ts"

export interface Binding { fetch(req: Request, init?: { cf?: { cacheKey: string } }): Promise<Response> }
export interface Loopback {
  /** pathAndQuery: path + sorted query (responses.ts canonical) */
  readonly api: (pathAndQuery: string, init: { method: string; headers: Record<string, string> }) => Promise<Response>
  readonly block: (i: number) => Promise<Response>
  readonly geoid: (band: number) => Promise<Response>
  readonly feed: () => Promise<Response>
}

/** Api's key in the cache: the tag, then path and sorted query. */
export const apiCacheKey = (pathAndQuery: string) => `/${CACHE_TAG}${pathAndQuery}`

/** Service bindings to ephem-compute (front door only; cloudflare.config.ts env COMPUTE, STORE), and COMPUTE_MODE: which
 *  path the front door takes. "binding" (default): ephem-compute over COMPUTE / STORE. "entrypoint": this Worker's own
 *  Api / BlockStore over ctx.exports (the pre-split layout; built with `--mode entrypoint`, for the split A/B). */
export interface ComputeBindings { readonly COMPUTE?: Binding | undefined; readonly STORE?: Binding | undefined; readonly COMPUTE_MODE?: string | undefined }
export type Bindings = Readonly<Record<string, Binding>>
type Name = "Api" | "BlockStore" | "MetarFeed"
export type Resolved = { readonly [K in Name]?: Binding | undefined }
/** Which binding answers each entrypoint: a service binding when the Worker has one (and COMPUTE_MODE is not
 *  "entrypoint"), else this Worker's own ctx.exports. The keys are the same either way (makeLoopback). */
export const resolveBindings = (exports: Bindings | undefined, env?: ComputeBindings): Resolved => {
  const svc = env?.COMPUTE_MODE === "entrypoint" ? undefined : env
  return { Api: svc?.COMPUTE ?? exports?.Api, BlockStore: svc?.STORE ?? exports?.BlockStore, MetarFeed: exports?.MetarFeed }
}

export const makeLoopback = (bindings: () => Resolved | undefined): Loopback => {
  const get = (name: Name) => { const b = bindings()?.[name]; if (!b) throw new Error(`loopback ${name} unavailable`); return b }
  return {
    // cf goes in fetch's second argument, as documented for ctx.exports (a Request copy may drop `cf`).
    api: (pq, init) => get("Api").fetch(new Request(`https://api.internal${pq}`, init), { cf: { cacheKey: apiCacheKey(pq) } }),
    block: i => get("BlockStore").fetch(new Request(`https://blocks.internal${blockPath(i)}`)),
    geoid: b => get("BlockStore").fetch(new Request(`https://blocks.internal${geoidPath(b)}`)),
    feed: () => get("MetarFeed").fetch(new Request(`https://feed.internal${FEED_PATH}`)),
  }
}
