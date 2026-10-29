// RPC entrypoint for operators: pull DE440 from JPL into R2, and report what R2 holds.
// Call it from another Worker through a service binding:
//   "services": [{ "binding": "EPHEM_ADMIN", "service": "ephem", "entrypoint": "Admin" }]
//   await env.EPHEM_ADMIN.ingest()        → IngestResult
//   await env.EPHEM_ADMIN.status()        → { present, sizeBytes, sha256, ingestedAt, matchesPinned }
import { WorkerEntrypoint } from "cloudflare:workers"
import { ingest, status, type IngestResult } from "./ingest.ts"
import type { R2BucketLike } from "./blocks.ts"

export interface AdminEnv { readonly EPH: R2BucketLike }

export class Admin extends WorkerEntrypoint<AdminEnv> {
  async ingest(opts: { force?: boolean } = {}): Promise<IngestResult> {
    return ingest({ bucket: this.env.EPH, fetch: url => fetch(url), fixedLength: fixedLengthStream }, opts)
  }
  async status() { return status(this.env.EPH) }
}

/** Workers' FixedLengthStream: lets R2 accept a streamed body of known size without buffering it. */
export const fixedLengthStream = (body: ReadableStream<Uint8Array>, length: number): ReadableStream<Uint8Array> => {
  const { readable, writable } = new FixedLengthStream(length)
  void body.pipeTo(writable)
  return readable
}
