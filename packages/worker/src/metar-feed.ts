// The METAR feed, cached by Workers Caching (no Cache API, no hand-written SWR or single-flight).
//   MetarFeed entrypoint  GET FEED_PATH → aviationweather.gov's gz bytes with Cache-Control FEED_CACHE_CONTROL. Workers
//                         Caching stores it per tier, serves it fresh for FRESH_S, then stale while one background
//                         revalidation runs (collapsed per data center), and on upstream failure serves stale-if-error.
//                         A revalidation arrives as a conditional request; it is passed upstream, and a 304 comes back
//                         as REVALIDATED.
//   consumer (makeFeed)   every weather request fetches FEED_PATH through ctx.exports.MetarFeed (cf-cache-status is the
//                         tier) and keeps the parsed table in isolate memory (L1), keyed by the upstream ETag /
//                         Last-Modified, so a version is parsed once per isolate.
import { parseMetars, type Table } from "./metar.ts"
import { CACHE_TAG } from "./cache-version.ts"

export const FEED_URL = "https://aviationweather.gov/data/cache/metars.cache.csv.gz"
/** Carries the cache tag: the cache is shared across deploys (src/cache-version.ts). */
export const FEED_PATH = `/feed/${CACHE_TAG}/metars.cache.csv.gz`
export const USER_AGENT = "ephem.ivar.workers.dev (METAR nearest-station lookup)"

/** Fresh window. Upstream says max-age=30 and regenerates the file about once a minute (Last-Modified moved 11:23 →
 *  11:25 on 2026-10-29), and METARs themselves are hourly: 60 s costs at most one feed generation. */
export const FRESH_S = 60
export const FRESH_MS = FRESH_S * 1000
/** Past fresh, the cache serves the stored copy immediately and revalidates in the background, up to here: the "few
 *  minutes of stale" Ivar accepts for a fast p99. Beyond it, a request waits for the revalidation. */
export const SWR_S = 600
/** If upstream fails while revalidating, serve the stored copy (STALE) for up to a day, then let the error through. */
export const SIE_S = 86_400
export const FEED_CACHE_CONTROL = `public, max-age=${FRESH_S}, stale-while-revalidate=${SWR_S}, stale-if-error=${SIE_S}`

// ───────────────────────── MetarFeed entrypoint ─────────────────────────

export interface UpstreamDeps {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>
  readonly now?: () => number
  readonly log?: (line: Record<string, unknown>) => void
}
const isGzip = (b: Uint8Array) => b[0] === 0x1f && b[1] === 0x8b

/** One upstream GET per call. Logs {"evt":"metar.upstream"} with status, bytes, ms and whether it was conditional. */
export const serveFeed = async (req: Request, deps: UpstreamDeps): Promise<Response> => {
  const now = deps.now ?? Date.now, log = deps.log ?? (l => console.log(JSON.stringify(l)))
  const fail = (status: number, msg: string) => new Response(msg, { status, headers: { "cache-control": "no-store", "content-type": "text/plain" } })
  if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "GET only")
  if (new URL(req.url).pathname !== FEED_PATH) return fail(404, "not found")
  const headers: Record<string, string> = { "user-agent": USER_AGENT }
  const inm = req.headers.get("if-none-match"), ims = req.headers.get("if-modified-since")
  if (inm) headers["if-none-match"] = inm
  if (ims) headers["if-modified-since"] = ims
  const t0 = now(), conditional = Boolean(inm || ims)
  let r: Response
  try { r = await deps.fetch(FEED_URL, { headers, cache: "no-store" }) } catch (e) {
    log({ evt: "metar.upstream", status: 0, bytes: 0, ms: now() - t0, conditional, error: String(e) })
    return fail(502, `upstream: ${String(e)}`)
  }
  const out = (status: number, body: ArrayBuffer | null) => {
    const h: Record<string, string> = { "cache-control": FEED_CACHE_CONTROL, "x-fetched-at": String(now()) }
    const etag = r.headers.get("etag"), lm = r.headers.get("last-modified")
    if (etag) h.etag = etag
    if (lm) h["last-modified"] = lm
    if (body) h["content-type"] = "application/gzip"
    log({ evt: "metar.upstream", status, bytes: body?.byteLength ?? 0, ms: now() - t0, conditional, version: etag ?? lm })
    return new Response(body, { status, headers: h })
  }
  if (r.status === 304) return out(304, null)
  if (r.status !== 200) {
    await r.body?.cancel()
    log({ evt: "metar.upstream", status: r.status, bytes: 0, ms: now() - t0, conditional })
    return fail(502, `upstream ${r.status}`)
  }
  const gz = await r.arrayBuffer()
  if (!isGzip(new Uint8Array(gz))) {
    log({ evt: "metar.upstream", status: 200, bytes: gz.byteLength, ms: now() - t0, conditional, error: "not gzip" })
    return fail(502, "upstream body is not gzip")
  }
  return out(200, gz)
}

// ───────────────────────── consumer (Api isolate) ─────────────────────────

/** Workers Caching's cf-cache-status of the loopback, lower-cased; `none` without a cache (tests, dev server);
 *  `stale-on-error` when the loopback failed and the isolate's own last table answered. */
export type Tier = "hit" | "miss" | "expired" | "stale" | "updating" | "revalidated" | "bypass" | "dynamic" | "none" | "stale-on-error"
const TIERS = new Set<string>(["hit", "miss", "expired", "stale", "updating", "revalidated", "bypass", "dynamic", "none"])

export interface Snapshot {
  readonly table: Table
  readonly etag: string | null
  readonly lastModified: string | null
  /** when MetarFeed last confirmed this version with upstream (200 or 304), ms */
  readonly fetchedAt: number
  /** upstream ETag, else Last-Modified: the data version L1 is keyed by */
  readonly version: string
}
export interface FeedResult {
  readonly snap: Snapshot
  readonly tier: Tier
  readonly dataAgeMs: number
  readonly bytes: number      // gz bytes this request read from the loopback (0 when the version was already parsed)
  readonly parsed: boolean    // this request paid for a parse
  readonly error: string | null
}
export interface FeedDeps {
  /** GET FEED_PATH: src/loopback.ts feed in prod; serveFeed directly in tests and the dev server */
  readonly fetch: (req: Request, traceparent?: string) => Promise<Response>
  readonly now?: () => number
  /** refuse a parse with fewer stations (a truncated or wrong file); the real feed has ~5 250 */
  readonly minStations?: number
}

export class FeedUnavailable extends Error { readonly _tag = "FeedUnavailable" }

const versionOf = (etag: string | null, lm: string | null, gzLen: number) => etag ?? lm ?? `len:${gzLen}`

/** gzip bytes (a .gz file, not Content-Encoding) → text. */
export const gunzip = async (gz: ArrayBuffer): Promise<string> => {
  const b = new Uint8Array(gz)
  if (!isGzip(b)) throw new FeedUnavailable(`feed is not gzip (first bytes ${b[0]?.toString(16)} ${b[1]?.toString(16)})`)
  return new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"))).text()
}

export const makeFeed = (deps: FeedDeps) => {
  const now = deps.now ?? Date.now
  let l1: Snapshot | undefined
  let parsing: { version: string; p: Promise<Snapshot> } | undefined   // a version is parsed once even under concurrency

  const build = async (gz: ArrayBuffer, etag: string | null, lastModified: string | null, fetchedAt: number): Promise<Snapshot> => {
    const table = parseMetars(await gunzip(gz))
    if (table.count < (deps.minStations ?? 1000)) throw new FeedUnavailable(`feed parsed to only ${table.count} stations`)
    return { table, etag, lastModified, fetchedAt, version: versionOf(etag, lastModified, gz.byteLength) }
  }
  const result = (snap: Snapshot, tier: Tier, extra: Partial<FeedResult> = {}): FeedResult =>
    ({ snap, tier, dataAgeMs: Math.max(0, now() - snap.fetchedAt), bytes: 0, parsed: false, error: null, ...extra })
  const onError = (e: unknown): FeedResult => {
    if (l1) return result(l1, "stale-on-error", { error: String(e) })
    throw e instanceof FeedUnavailable ? e : new FeedUnavailable(String(e))
  }

  const get = async (traceparent?: string): Promise<FeedResult> => {
    let r: Response
    try { r = await deps.fetch(new Request(`https://feed.internal${FEED_PATH}`), traceparent) } catch (e) { return onError(e) }
    const s = (r.headers.get("cf-cache-status") ?? "none").toLowerCase()
    const tier = (TIERS.has(s) ? s : "none") as Tier
    if (r.status !== 200) { await r.body?.cancel(); return onError(new FeedUnavailable(`feed ${r.status}${tier === "none" ? "" : ` (${tier})`}`)) }
    const etag = r.headers.get("etag"), lm = r.headers.get("last-modified")
    const fetchedAt = Number(r.headers.get("x-fetched-at")) || now()
    const version = etag ?? lm
    // Same version as L1 (or an older copy from a tier that has not caught up): no parse, no body read.
    if (l1 && version !== null && (version === l1.version || fetchedAt < l1.fetchedAt)) {
      await r.body?.cancel()
      if (version === l1.version && fetchedAt > l1.fetchedAt) l1 = { ...l1, fetchedAt }
      return result(l1, tier)
    }
    try {
      const gz = await r.arrayBuffer(), v = versionOf(etag, lm, gz.byteLength)
      if (l1 && v === l1.version) return result(l1, tier, { bytes: gz.byteLength })
      const mine = parsing?.version !== v
      if (mine) parsing = { version: v, p: build(gz, etag, lm, fetchedAt) }
      const p = parsing!.p
      try { l1 = await p } finally { if (parsing?.p === p) parsing = undefined }
      return result(l1, tier, { bytes: gz.byteLength, parsed: mine })
    } catch (e) { return onError(e) }
  }
  return { get, peek: () => l1 }
}
export type Feed = ReturnType<typeof makeFeed>
