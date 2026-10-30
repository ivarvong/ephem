// EGM96 geoid bands: the second I/O boundary (after DE440 blocks). Core's geoidUndulation reads bands from an injected
// source; here that source is an in-isolate L1 filled, before each computation, with the ≤ 2 bands the observer's latitude
// needs (geoidBandsFor), fetched through the BlockStore loopback: Workers Caching (immutable) in front of an exact R2 range
// read of the one sha-addressed object in bucket ephem-geoid (scripts/geoid-r2.ts). Every band is checked against its
// sha256 in egm96-bands.ts before it is cached or used; any failure is GeoidUnavailable (503), never a guessed height.
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { EGM96_BANDS, GEOID_BANDS, geoidBandsFor, setGeoidSource } from "@ephem/core"
import { GeoidUnavailable } from "@ephem/api"
import { CACHE_TAG } from "./cache-version.ts"
import type { R2BucketLike } from "./blocks.ts"

const SHA16 = EGM96_BANDS.sha256.slice(0, 16)
/** BlockStore path of band b: cache tag + object hash, so a new grid or format can never be served from an old entry. */
export const geoidPath = (b: number) => `/geoid/${CACHE_TAG}/${SHA16}/${b}`
export const GEOID_PATH_RE = new RegExp(`^/geoid/${CACHE_TAG}/${SHA16}/(\\d+)$`)

/** Throws unless `buf` is exactly band b of the manifest (length and sha256 prefix). */
export const verifyBand = async (b: number, buf: ArrayBuffer): Promise<Uint8Array> => {
  const m = EGM96_BANDS.bands[b]
  if (!m) throw new RangeError(`no EGM96 band ${b} (0..${GEOID_BANDS - 1})`)
  if (buf.byteLength !== m[1]) throw new RangeError(`EGM96 band ${b}: ${buf.byteLength} bytes, expected ${m[1]}`)
  const h = [...new Uint8Array(await crypto.subtle.digest("SHA-256", buf))].slice(0, 8).map(x => x.toString(16).padStart(2, "0")).join("")
  if (h !== m[2]) throw new RangeError(`EGM96 band ${b}: sha256 ${h}…, expected ${m[2]}…`)
  return new Uint8Array(buf)
}

/** One band's bytes and the cache status of the fetch that produced them (Workers Caching's cf-cache-status, or ORIGIN). */
export type GeoidFetch = (b: number) => Promise<{ readonly buf: ArrayBuffer; readonly status: string }>
/** Per load, flat for span attributes: `geoid.bands`, `geoid.l1`, `geoid.<status>` per fetched band, `geoid.fetchedBytes`. */
export type GeoidStats = Record<string, number>

export class Geoid extends Context.Service<Geoid, {
  /** Make the bands a lookup at `lat` reads available to core's geoidUndulation. */
  readonly load: (lat: number) => Effect.Effect<GeoidStats, GeoidUnavailable>
}>()("@ephem/worker/Geoid") {}

/** "L1" when the isolate had every band, else fetch statuses with counts ("HIT:1", "MISS:2"). */
export const geoidCache = (s: GeoidStats): string => {
  const parts = Object.entries(s).filter(([k, v]) => /^geoid\.[a-z]/.test(k) && !["geoid.bands", "geoid.l1", "geoid.fetchedBytes"].includes(k) && v > 0)
    .map(([k, v]) => `${k.slice(6).toUpperCase()}:${v}`)
  return parts.length ? parts.join(",") : "L1"
}

/** The Worker's geoid: installs the isolate L1 as core's band source (call once per isolate). */
export const makeGeoid = (fetchBand: GeoidFetch) => {
  const l1 = new Map<number, Uint8Array>()
  const inflight = new Map<number, Promise<{ bytes: Uint8Array; status: string }>>()   // one fetch per band per isolate
  setGeoidSource(b => { const x = l1.get(b); if (!x) throw new Error(`EGM96 geoid band ${b} was not prefetched`); return x })
  const load = (lat: number) => Effect.tryPromise({
    try: async () => {
      const want = geoidBandsFor(lat), stats: GeoidStats = { "geoid.bands": want.length, "geoid.l1": 0, "geoid.fetchedBytes": 0 }
      await Promise.all(want.map(async b => {
        if (l1.has(b)) { stats["geoid.l1"]!++; return }
        const pending = inflight.get(b)
        if (pending) { await pending; stats["geoid.l1"]!++; return }
        const p = fetchBand(b).then(async r => ({ bytes: await verifyBand(b, r.buf), status: r.status }))
        inflight.set(b, p)
        try {
          const { bytes, status } = await p
          const k = `geoid.${status.toLowerCase()}`; stats[k] = (stats[k] ?? 0) + 1; stats["geoid.fetchedBytes"]! += bytes.byteLength
          l1.set(b, bytes)
        } finally { inflight.delete(b) }
      }))
      return stats
    },
    catch: e => new GeoidUnavailable({ message: `EGM96 geoid unavailable: ${e instanceof Error ? e.message : String(e)}` }),
  })
  return Layer.succeed(Geoid, { load })
}

/** Tests and the dev server: core's band source is installed by the caller (setGeoidSource), so there is nothing to fetch. */
export const GeoidInstalled = Layer.succeed(Geoid, { load: lat => Effect.succeed({ "geoid.bands": geoidBandsFor(lat).length, "geoid.l1": geoidBandsFor(lat).length }) })

/** Bands through the BlockStore loopback (src/loopback.ts geoid). */
export const loopbackGeoid = (fetchBand: (b: number) => Promise<Response>): GeoidFetch => async b => {
  const r = await fetchBand(b)
  if (r.status !== 200) throw new Error(`BlockStore ${r.status} for geoid band ${b}: ${(await r.text()).slice(0, 200)}`)
  return { buf: await r.arrayBuffer(), status: r.headers.get("cf-cache-status") ?? "NONE" }
}

/** Origin: band b's exact byte range of the geoid object. */
export type GeoidOrigin = (b: number) => Promise<ArrayBuffer>
export const r2GeoidOrigin = (bucket: R2BucketLike): GeoidOrigin => async b => {
  const m = EGM96_BANDS.bands[b]; if (!m) throw new RangeError(`no EGM96 band ${b}`)
  const obj = await bucket.get(EGM96_BANDS.key, { range: { offset: m[0], length: m[1] } })
  if (!obj) throw new Error(`R2 object ${EGM96_BANDS.key} missing: run scripts/geoid-r2.ts upload`)
  return obj.arrayBuffer()
}

export const GEOID_CACHE_CONTROL = "public, max-age=31536000, immutable"
/** BlockStore's fetch for GET <geoidPath(b)>: one verified band, immutable; failures are no-store, never cached. */
export const serveGeoid = async (req: Request, origin: GeoidOrigin): Promise<Response> => {
  const fail = (status: number, msg: string) => new Response(msg, { status, headers: { "cache-control": "no-store", "content-type": "text/plain" } })
  if (req.method !== "GET" && req.method !== "HEAD") return fail(405, "GET only")
  const m = GEOID_PATH_RE.exec(new URL(req.url).pathname), b = m ? Number(m[1]) : NaN
  if (!Number.isInteger(b) || b < 0 || b >= GEOID_BANDS) return fail(404, "no such geoid band")
  try {
    const buf = await origin(b); await verifyBand(b, buf)
    return new Response(buf, { headers: { "content-type": "application/octet-stream", "cache-control": GEOID_CACHE_CONTROL } })
  } catch (e) { return fail(502, String(e)) }
}
