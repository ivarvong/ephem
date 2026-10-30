// The one I/O boundary: fetching DE440 blocks (8 144 B each).
//   L1 in-isolate LRU · then one fetch per missing block from a BlockFetch. In prod that is the BlockStore entrypoint over
//   ctx.exports, i.e. Workers Caching (lower tier → upper tier) in front of an exact R2 range read; tests and the dev
//   server read the bytes directly. The pure core never sees any of this.
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { currentTraceparent } from "./trace.ts"
import { DE440, type BlockSource } from "@ephem/core"
import { CACHE_TAG } from "./cache-version.ts"

export const REC = DE440.recBytes
/** Byte offset of block i in linux_p1550p2650.440 (two header records precede the data). */
export const blockOffset = (i: number) => (2 + i) * REC
export const R2_KEY = `de440/${DE440.file}`
/** BlockStore path: the cache tag (the cache is shared across deploys; src/cache-version.ts) and the file hash, so a
 *  different file can never be served from an old cache entry. */
export const blockPath = (i: number) => `/block/${CACHE_TAG}/${DE440.sha256.slice(0, 16)}/${i}`
export const BLOCK_CACHE_CONTROL = "public, max-age=31536000, immutable"

export class BlockLoadError extends Error {
  readonly _tag = "BlockLoadError"
  readonly block: number
  constructor(block: number, cause: unknown) { super(`cannot load DE440 block ${block}: ${String(cause)}`, { cause }); this.block = block }
}

/** Per load: `l1` isolate hits, `blocks_<status>` per fetched block by the fetch's cache status (blocks_hit, blocks_miss,
 *  blocks_origin for a direct read, …), `fetchedBytes`, and `originReads` / `originBytes` only for reads this isolate made
 *  itself (direct origin; via BlockStore the R2 read happens in BlockStore's invocation, on a MISS). Flat, so it maps onto span attributes (cache.*) and diagnostics. */
export type CacheStats = Record<string, number>
export interface Loaded { readonly src: BlockSource; readonly stats: CacheStats }

export class Blocks extends Context.Service<Blocks, {
  /** Resolve every listed block, then hand back a synchronous source over exactly those blocks. */
  readonly load: (blocks: ReadonlyArray<number>) => Effect.Effect<Loaded, BlockLoadError>
}>()("@ephem/worker/Blocks") {}

/** The load in one string for logs: "L1" when memory answered everything, else fetch statuses with counts, "HIT:2,MISS:1". */
export const blocksCache = (s: CacheStats): string => {
  const parts = Object.entries(s).filter(([k, v]) => k.startsWith("blocks_") && v > 0).map(([k, v]) => `${k.slice(7).toUpperCase()}:${v}`)
  return parts.length ? parts.join(",") : "L1"
}

/** Origin: read `count` consecutive blocks starting at `first`, as one byte range. */
export type RangeOrigin = (first: number, count: number) => Promise<ArrayBuffer>
/** One block, and the cache status of the fetch that produced it (Workers Caching's cf-cache-status, or ORIGIN). */
export type BlockFetch = (i: number, traceparent?: string) => Promise<{ readonly buf: ArrayBuffer; readonly status: string }>

class Lru<K, V> {
  private readonly m = new Map<K, V>()
  private readonly cap: number
  constructor(cap: number) { this.cap = cap }
  get(k: K): V | undefined { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v) } return v }
  set(k: K, v: V): void { if (this.m.size >= this.cap) this.m.delete(this.m.keys().next().value as K); this.m.set(k, v) }
}

/** Each record starts with its own JD span; check it before the bytes are trusted or cached. */
export const verifyBlock = (i: number, buf: ArrayBuffer): ArrayBuffer => {
  if (buf.byteLength !== REC) throw new RangeError(`block ${i}: ${buf.byteLength} bytes, expected ${REC}`)
  const f = new Float64Array(buf, 0, 2), jd0 = DE440.jdStart + i * DE440.blockDays
  if (Math.abs(f[0]! - jd0) > 1e-6 || Math.abs(f[1]! - jd0 - DE440.blockDays) > 1e-6) throw new RangeError(`block ${i}: header ${f[0]}..${f[1]}, expected ${jd0}..${jd0 + DE440.blockDays}`)
  return buf
}

/** A direct origin as a BlockFetch (tests, dev server): one range read per block, status ORIGIN. */
export const direct = (origin: RangeOrigin): BlockFetch => async i => ({ buf: await origin(i, 1), status: "ORIGIN" })

export const makeBlocks = (fetchBlock: BlockFetch, l1Capacity = 512 /* 4.2 MB */) => {
  const l1 = new Lru<number, ArrayBuffer>(l1Capacity)
  const inflight = new Map<number, Promise<{ buf: ArrayBuffer; status: string }>>()   // one fetch per block per isolate

  const load = (wanted: ReadonlyArray<number>) => Effect.flatMap(currentTraceparent, tp => Effect.tryPromise({
    try: async () => {
      const stats: CacheStats = { l1: 0, fetchedBytes: 0 }
      const got = new Map<number, ArrayBuffer>()
      const ids = [...new Set(wanted)].toSorted((a, b) => a - b)
      for (const i of ids) {
        if (i < 0 || i >= DE440.nBlocks) throw new RangeError(`block ${i} outside DE440 (0..${DE440.nBlocks - 1})`)
        const hit = l1.get(i); if (hit) { stats.l1!++; got.set(i, hit) }
      }
      await Promise.all(ids.filter(i => !got.has(i)).map(async i => {
        const pending = inflight.get(i)
        if (pending) { got.set(i, (await pending).buf); stats.l1!++; return }
        const p = fetchBlock(i, tp).then(r => ({ buf: verifyBlock(i, r.buf), status: r.status }))
        inflight.set(i, p)
        try {
          const { buf, status } = await p
          const k = `blocks_${status.toLowerCase()}`; stats[k] = (stats[k] ?? 0) + 1; stats.fetchedBytes! += buf.byteLength
          if (status === "ORIGIN") { stats.originReads = (stats.originReads ?? 0) + 1; stats.originBytes = (stats.originBytes ?? 0) + buf.byteLength }
          got.set(i, buf); l1.set(i, buf)
        } finally { inflight.delete(i) }
      }))
      const src: BlockSource = i => { const b = got.get(i); if (!b) throw new RangeError(`block ${i} was not prefetched`); return b }
      return { src, stats }
    },
    catch: e => new BlockLoadError(wanted[0] ?? -1, e),
  }))
  return Layer.succeed(Blocks, { load })
}

/** Blocks through the BlockStore loopback (src/loopback.ts block): Workers Caching answers or runs BlockStore. */
export const loopbackBlocks = (fetchBlock: (i: number, traceparent?: string) => Promise<Response>): BlockFetch => async (i, tp) => {
  const r = await fetchBlock(i, tp)
  if (r.status !== 200) throw new Error(`BlockStore ${r.status} for block ${i}: ${(await r.text()).slice(0, 200)}`)
  return { buf: await r.arrayBuffer(), status: r.headers.get("cf-cache-status") ?? "NONE" }
}

/** The BlockStore entrypoint's fetch: GET <blockPath(i)> → one verified block from R2, immutable (blocks never change
 *  for a given file hash). Failures are no-store so they are never cached. */
export const serveBlock = async (req: Request, origin: RangeOrigin): Promise<Response> => {
  const fail = (status: number, msg: string) => new Response(msg, { status, headers: { "cache-control": "no-store", "content-type": "text/plain" } })
  if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "GET only")
  const m = new RegExp(`^/block/${CACHE_TAG}/${DE440.sha256.slice(0, 16)}/(\\d+)$`).exec(new URL(req.url).pathname)
  const i = m ? Number(m[1]) : NaN
  if (!Number.isInteger(i) || i < 0 || i >= DE440.nBlocks) return fail(404, "no such block")
  try {
    const buf = verifyBlock(i, await origin(i, 1))
    return new Response(buf, { headers: { "content-type": "application/octet-stream", "cache-control": BLOCK_CACHE_CONTROL } })
  } catch (e) { return fail(502, String(e)) }
}

// ── Cloudflare bindings (structural types; no dependency on @cloudflare/workers-types) ──
export interface R2Range { offset: number; length: number }
export interface R2ObjectBodyLike { arrayBuffer(): Promise<ArrayBuffer>; size: number }
export interface R2BucketLike {
  get(key: string, options?: { range?: R2Range }): Promise<R2ObjectBodyLike | null>
  head(key: string): Promise<{ size: number; customMetadata?: Record<string, string>; checksums?: unknown; uploaded?: Date } | null>
  put(key: string, value: ReadableStream | ArrayBuffer, options?: { sha256?: string; httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> }): Promise<unknown>
}

/** R2 origin: exact-range reads of the single DE440 object. */
export const r2Origin = (bucket: R2BucketLike): RangeOrigin => async (first, count) => {
  const obj = await bucket.get(R2_KEY, { range: { offset: blockOffset(first), length: count * REC } })
  if (!obj) throw new Error(`R2 object ${R2_KEY} missing — run the ingest RPC (Admin.ingest)`)
  return obj.arrayBuffer()
}
