// ephem's CPU-heavy, cache-enabled entrypoints (exported by src/index.ts); the front door calls them over ctx.exports
// (src/loopback.ts). They ran in a separate Worker (ephem-compute) from 2026-10-30 until a concurrent A/B removed it (DESIGN §12.0).
//   Api         cache ON.  The /v1 routes only (src/router.ts makeApiHandler); Cache-Control per route (src/responses.ts).
//               Every deterministic answer, every alignment/search window. Sets x-ephem-compute-version (stored with the
//               cached answer, so on a HIT it names the version that computed it).
//   BlockStore  cache ON.  GET /block/v<N>/<sha>/<i> → one DE440 block (R2 ephem-de440), GET /geoid/v<N>/<sha>/<band> → one
//                          EGM96 band (R2 ephem-geoid); exact range reads, sha-checked, immutable. Called by the Api and by
//                          the front door's live routes (both ctx.exports).
import { WorkerEntrypoint, tracing } from "cloudflare:workers"
import { makeApiHandler } from "./router.ts"
import { loopbackBlocks, makeBlocks, r2Origin, serveBlock, type R2BucketLike } from "./blocks.ts"
import { recordLoopbackTrace, setTracing } from "./trace.ts"
import { loopbackGeoid, makeGeoid, r2GeoidOrigin, serveGeoid } from "./geoid.ts"
import { defaultNoStore } from "./responses.ts"
import { makeLoopback, resolveBindings, type Bindings } from "./loopback.ts"
import { pipelineSink, type PipelineLike, type RequestRow } from "./requestlog.ts"

interface Env { readonly EPH: R2BucketLike; readonly GEOID: R2BucketLike; readonly LOGS?: PipelineLike<RequestRow>; readonly VERSION?: { readonly id: string }; readonly REQUEST_LOGS?: string }

setTracing(tracing)
let loop: Bindings | undefined
const lb = makeLoopback(() => resolveBindings(loop))
const blocks = makeBlocks(loopbackBlocks(lb.block))
const geoid = makeGeoid(loopbackGeoid(lb.geoid))
let api: ReturnType<typeof makeApiHandler> | undefined

export class Api extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    loop = this.ctx.exports
    api ??= makeApiHandler(blocks, { role: "api" }, undefined, geoid)
    const env = this.env, sink = env.LOGS && env.REQUEST_LOGS !== "off" ? pipelineSink(env.LOGS, p => this.ctx.waitUntil(p), env.VERSION?.id, "api") : undefined
    const res = defaultNoStore(await api(request, sink))
    if (env.VERSION?.id) res.headers.set("x-ephem-compute-version", env.VERSION.id)
    return res
  }
}

export class BlockStore extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    recordLoopbackTrace(request)
    return new URL(request.url).pathname.startsWith("/geoid/") ? serveGeoid(request, r2GeoidOrigin(this.env.GEOID)) : serveBlock(request, r2Origin(this.env.EPH))
  }
}
