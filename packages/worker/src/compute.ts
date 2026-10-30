// ephem-compute: the CPU-heavy, cache-enabled entrypoints, in their own Worker so their misses run in their own isolate pool
// (packages/compute deploys this file). ephem's front door calls them over service bindings (src/loopback.ts).
//   Api         cache ON.  The /v1 routes only (src/router.ts makeApiHandler); Cache-Control per route (src/responses.ts).
//               Every deterministic answer, every alignment/search window. Sets x-ephem-compute-version (stored with the
//               cached answer, so on a HIT it names the version that computed it).
//   BlockStore  cache ON.  GET /block/v<N>/<sha>/<i> → one DE440 block (R2 ephem-de440), GET /geoid/v<N>/<sha>/<band> → one
//                          EGM96 band (R2 ephem-geoid); exact range reads, sha-checked, immutable. Called by this Worker's
//                          Api (ctx.exports) and by the front door's live routes (service binding STORE).
//   default     cache OFF. 404: ephem-compute has no public route (workers.dev is off).
import { WorkerEntrypoint, tracing } from "cloudflare:workers"
import { makeApiHandler } from "./router.ts"
import { loopbackBlocks, makeBlocks, r2Origin, serveBlock, type R2BucketLike } from "./blocks.ts"
import { setTracing } from "./trace.ts"
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

export default {
  async fetch(): Promise<Response> { return new Response("ephem-compute has no public routes; see https://ephem.ivar.workers.dev\n", { status: 404, headers: { "cache-control": "no-store" } }) },
}

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
    return new URL(request.url).pathname.startsWith("/geoid/") ? serveGeoid(request, r2GeoidOrigin(this.env.GEOID)) : serveBlock(request, r2Origin(this.env.EPH))
  }
}
