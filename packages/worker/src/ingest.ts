// Pull JPL's DE440 binary into R2, verified. Called from the Admin RPC entrypoint (admin.ts).
//   1. If the object exists with the pinned SHA-256 and size, do nothing (idempotent).
//   2. Stream https://ssd.jpl.nasa.gov/.../linux_p1550p2650.440 straight into R2 (no buffering in the isolate);
//      R2 verifies the SHA-256 server-side and rejects the write on mismatch.
//   3. Read back the header records and two data blocks by range and check them against the constants core is built on.
import { DE440 } from "@ephem/core"
import { R2_KEY, REC, blockOffset, verifyBlock, type R2BucketLike } from "./blocks.ts"

export interface IngestResult {
  readonly status: "already-present" | "ingested"
  readonly key: string; readonly sizeBytes: number; readonly sha256: string
  readonly source: string; readonly elapsedMs: number
  readonly verified: { readonly header: HeaderCheck; readonly firstBlockJd: number; readonly lastBlockJd: number }
}
export interface HeaderCheck { readonly numde: number; readonly jdStart: number; readonly jdEnd: number; readonly blockDays: number; readonly au: number; readonly emrat: number; readonly ipt: ReadonlyArray<readonly [number, number, number]> }

/** Parse the fields of the binary header that core hard-codes (byte offsets from the JPL "Linux" layout). */
export const parseHeader = (buf: ArrayBuffer): HeaderCheck => {
  const v = new DataView(buf)
  const ss = [v.getFloat64(2652, true), v.getFloat64(2660, true), v.getFloat64(2668, true)] as const
  const au = v.getFloat64(2680, true), emrat = v.getFloat64(2688, true)
  const ipt: Array<[number, number, number]> = []
  for (let k = 0; k < 12; k++) ipt.push([v.getInt32(2696 + 12 * k, true), v.getInt32(2700 + 12 * k, true), v.getInt32(2704 + 12 * k, true)])
  const numde = v.getInt32(2840, true)
  ipt.push([v.getInt32(2844, true), v.getInt32(2848, true), v.getInt32(2852, true)])   // librations (lpt)
  return { numde, jdStart: ss[0], jdEnd: ss[1], blockDays: ss[2], au, emrat, ipt }
}

export const checkHeader = (h: HeaderCheck): void => {
  const bad: string[] = []
  if (h.numde !== DE440.numde) bad.push(`numde ${h.numde}`)
  if (h.jdStart !== DE440.jdStart || h.jdEnd !== DE440.jdEnd || h.blockDays !== DE440.blockDays) bad.push(`span ${h.jdStart}..${h.jdEnd}/${h.blockDays}`)
  if (h.au !== DE440.au || h.emrat !== DE440.emrat) bad.push(`au/emrat ${h.au}/${h.emrat}`)
  DE440.ipt.forEach((p, k) => { const q = h.ipt[k]; if (!q || q[0] !== p[0] || q[1] !== p[1] || q[2] !== p[2]) bad.push(`ipt[${k}] ${q}`) })
  if (bad.length) throw new Error(`DE440 header does not match the constants in @ephem/core: ${bad.join("; ")}`)
}

const verifyObject = async (bucket: R2BucketLike): Promise<IngestResult["verified"]> => {
  const head = await bucket.get(R2_KEY, { range: { offset: 0, length: 2 * REC } })
  if (!head) throw new Error("object vanished during verification")
  const header = parseHeader(await head.arrayBuffer()); checkHeader(header)
  const last = DE440.nBlocks - 1
  const [b0, bn] = await Promise.all([0, last].map(async i => {
    const o = await bucket.get(R2_KEY, { range: { offset: blockOffset(i), length: REC } })
    if (!o) throw new Error(`block ${i} unreadable`)
    return verifyBlock(i, await o.arrayBuffer())
  }))
  return { header, firstBlockJd: new Float64Array(b0!, 0, 1)[0]!, lastBlockJd: new Float64Array(bn!, 0, 1)[0]! }
}

export interface IngestDeps {
  readonly bucket: R2BucketLike
  readonly fetch: (url: string) => Promise<Response>
  /** Wrap a stream with a known length (Workers' FixedLengthStream); R2 needs the length for a streamed put. */
  readonly fixedLength: (body: ReadableStream<Uint8Array>, length: number) => ReadableStream<Uint8Array>
  readonly now?: () => number
}

export const ingest = async (deps: IngestDeps, opts: { force?: boolean } = {}): Promise<IngestResult> => {
  const now = deps.now ?? (() => Date.now()), t0 = now()
  const existing = await deps.bucket.head(R2_KEY)
  const present = existing && existing.size === DE440.sizeBytes && existing.customMetadata?.sha256 === DE440.sha256
  if (!present || opts.force) {
    const res = await deps.fetch(DE440.url)
    if (!res.ok || !res.body) throw new Error(`JPL responded ${res.status} for ${DE440.url}`)
    const len = Number(res.headers.get("content-length"))
    if (len !== DE440.sizeBytes) throw new Error(`JPL content-length ${len}, expected ${DE440.sizeBytes}`)
    await deps.bucket.put(R2_KEY, deps.fixedLength(res.body, DE440.sizeBytes), {
      sha256: DE440.sha256,                                  // R2 rejects the object if the bytes do not hash to this
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: { sha256: DE440.sha256, source: DE440.url, ingestedAt: new Date(now()).toISOString() },
    })
  }
  const verified = await verifyObject(deps.bucket)
  return { status: present && !opts.force ? "already-present" : "ingested", key: R2_KEY, sizeBytes: DE440.sizeBytes, sha256: DE440.sha256, source: DE440.url, elapsedMs: now() - t0, verified }
}

export const status = async (bucket: R2BucketLike) => {
  const h = await bucket.head(R2_KEY)
  return h
    ? { present: true, key: R2_KEY, sizeBytes: h.size, sha256: h.customMetadata?.sha256 ?? null, ingestedAt: h.customMetadata?.ingestedAt ?? null, matchesPinned: h.size === DE440.sizeBytes && h.customMetadata?.sha256 === DE440.sha256 }
    : { present: false, key: R2_KEY }
}
