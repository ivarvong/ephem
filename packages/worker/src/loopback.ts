// The one way to call our own cache-enabled entrypoints (ctx.exports: Api, BlockStore, MetarFeed, same Worker and version as
// the caller); test/loopback.test.ts fails if any ctx.exports fetch bypasses it (or any service-binding read creeps back:
// the ephem-compute split was measured and removed, DESIGN §12.0).
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

export type Bindings = Readonly<Record<string, Binding>>
type Name = "Api" | "BlockStore" | "MetarFeed"
export type Resolved = { readonly [K in Name]?: Binding | undefined }
/** Which binding answers each entrypoint: this Worker's own ctx.exports. */
export const resolveBindings = (exports: Bindings | undefined): Resolved =>
  ({ Api: exports?.Api, BlockStore: exports?.BlockStore, MetarFeed: exports?.MetarFeed })

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
