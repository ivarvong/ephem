// The one way to call our own cache-enabled entrypoints; test/loopback.test.ts fails if any ctx.exports fetch bypasses it.
// crossVersionCache is on (Worker-wide), so an entry is shared by every deployed version; the only partition is the cache
// tag in each key (src/cache-version.ts):
//   Api         cf.cacheKey = /v<N>/<path?sorted query>
//   BlockStore  /block/v<N>/<sha16>/<i>   (blocks.ts blockPath)
//   MetarFeed   /feed/v<N>/metars.cache.csv.gz   (metar-feed.ts FEED_PATH)
import { CACHE_TAG } from "./cache-version.ts"
import { blockPath } from "./blocks.ts"
import { FEED_PATH } from "./metar-feed.ts"

export interface Binding { fetch(req: Request, init?: { cf?: { cacheKey: string } }): Promise<Response> }
export interface Loopback {
  /** pathAndQuery: path + sorted query (responses.ts canonical) */
  readonly api: (pathAndQuery: string, init: { method: string; headers: Record<string, string> }) => Promise<Response>
  readonly block: (i: number) => Promise<Response>
  readonly feed: () => Promise<Response>
}

/** Api's key in the cache: the tag, then path and sorted query. */
export const apiCacheKey = (pathAndQuery: string) => `/${CACHE_TAG}${pathAndQuery}`

export const makeLoopback = (exports: () => Readonly<Record<string, Binding>> | undefined): Loopback => {
  const get = (name: "Api" | "BlockStore" | "MetarFeed") => { const b = exports()?.[name]; if (!b) throw new Error(`ctx.exports.${name} unavailable`); return b }
  return {
    // cf goes in fetch's second argument, as documented for ctx.exports (a Request copy may drop `cf`).
    api: (pq, init) => get("Api").fetch(new Request(`https://api.internal${pq}`, init), { cf: { cacheKey: apiCacheKey(pq) } }),
    block: i => get("BlockStore").fetch(new Request(`https://blocks.internal${blockPath(i)}`)),
    feed: () => get("MetarFeed").fetch(new Request(`https://feed.internal${FEED_PATH}`)),
  }
}
