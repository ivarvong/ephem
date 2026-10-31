// ephem: the front door. Workers Caching only (no Cache API); which entrypoints are cached is cloudflare.config.ts `exports`.
//   default     cache OFF. Always runs (traces, logs, request.cf, `/`, `/mcp`, live position / magnetic, weather, the
//               alignment/search merge); every deterministic GET /v1/* is forwarded to the Api over ctx.exports.
//   Api         cache ON.  The /v1 routes (src/compute.ts, lean router src/router.ts); every deterministic answer and search window.
//   BlockStore  cache ON.  DE440 blocks and EGM96 bands from R2 (src/compute.ts).
//   MetarFeed   cache ON.  GET /feed/v<N>/metars.cache.csv.gz → aviationweather.gov's feed, max-age + SWR + stale-if-error.
//   Admin       RPC only (ingest).
// One Worker: a separate ephem-compute Worker behind service bindings was tried and removed by a concurrent A/B
// (2026-10-30, DESIGN §12.0): faster scans, but +3 % CPU per scan with a CI excluding zero. Live routes' blocks: L1 isolate
// LRU → BlockStore loopback (Workers Cache → R2). Weather: L1 parsed table → MetarFeed loopback. All loopbacks:
// src/loopback.ts; cache tag: src/cache-version.ts.
import { WorkerEntrypoint, tracing } from "cloudflare:workers"
import { makeHandler } from "./app.ts"
import { loopbackBlocks, makeBlocks } from "./blocks.ts"
import { recordLoopbackTrace, setTracing } from "./trace.ts"
import { loopbackGeoid, makeGeoid } from "./geoid.ts"
import { makeLoopback, resolveBindings, type Bindings } from "./loopback.ts"
import { makeFeed, serveFeed } from "./metar-feed.ts"
import { weatherLive } from "./weather.ts"
import { pipelineSink, type PipelineLike, type RequestRow } from "./requestlog.ts"
import { rumPipelineSink, type RumRow } from "./rum.ts"
import { favicon } from "./favicon.ts"
import { ogFront, setOgTracing } from "./og-render.ts"
export { Admin } from "./admin.ts"
export { Og } from "./og-entry.ts"   // cache ON: the link-preview PNG (src/og.ts scene, rendered by glyph)
export { Api, BlockStore } from "./compute.ts"   // cache ON (cloudflare.config.ts); called over ctx.exports

// LOGS: Basin stream ephem_requests (one row per request, src/requestlog.ts); VERSION: this Worker version's id for the row;
// REQUEST_LOGS: "off" disables rows (the logging-overhead A/B). RUM: ephem_rum (POST /rum, src/rum.ts).
interface Env { readonly LOGS?: PipelineLike<RequestRow>; readonly RUM?: PipelineLike<RumRow>; readonly VERSION?: { readonly id: string }; readonly REQUEST_LOGS?: string }
interface Ctx { waitUntil(p: Promise<unknown>): void; readonly exports: Bindings }

setTracing(tracing)
setOgTracing(tracing)
// ctx.exports of the invocation in flight. The bindings are the same objects for every invocation of this isolate.
let loop: Bindings | undefined
const lb = makeLoopback(() => resolveBindings(loop))   // every loopback fetch goes through src/loopback.ts (test/loopback.test.ts)

// One Blocks L1 and one parsed METAR table per isolate.
const blocks = makeBlocks(loopbackBlocks(lb.block))
const geoid = makeGeoid(loopbackGeoid(lb.geoid))
const weather = weatherLive(makeFeed({ fetch: (_req, tp) => lb.feed(tp) }))
let front: ReturnType<typeof makeHandler> | undefined

// x-ephem-version: the front door's Worker version id on every response, so scripts/smoke.sh can prove a version-pinned
// request (Cloudflare-Workers-Version-Overrides) reached the version it pinned, and a rollback is visible per request.
// (x-ephem-compute-version, set by the Api on forwarded answers, names the version that computed it: stored with a cached
// answer, so on a HIT it can be an earlier version.)
const withVersion = (r: Response, id: string | undefined): Response => {
  if (!id) return r
  try { r.headers.set("x-ephem-version", id); return r } catch { const c = new Response(r.body, r); c.headers.set("x-ephem-version", id); return c }
}

// x-ephem-errors: this isolate's error count since it started (console.error lines, which is every *_failed log, and
// unhandled rejections), only on responses to requests that carry x-ephem-smoke. A pinned canary's isolates serve only the
// smoke, so smoke.sh --pin fails on any non-zero count: the deterministic half of the telemetry gate (an error in
// waitUntil after a response shows on the isolate's next request). Not on other responses: nobody else needs it.
let isolateErrors = 0
const consoleError = console.error.bind(console)
console.error = (...args: unknown[]) => { isolateErrors++; consoleError(...args) }
;(globalThis as { addEventListener?: (t: string, f: () => void) => void }).addEventListener?.("unhandledrejection", () => { isolateErrors++ })
const withErrors = (r: Response, request: Request): Response => {
  if (!request.headers.has("x-ephem-smoke")) return r
  try { r.headers.set("x-ephem-errors", String(isolateErrors)); return r } catch { const c = new Response(r.body, r); c.headers.set("x-ephem-errors", String(isolateErrors)); return c }
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const icon = favicon(request); if (icon) return withVersion(icon, env.VERSION?.id)   // before the app: no router, no request row
    loop = ctx.exports
    const og = await ogFront(request, lb, tracing); if (og) return withErrors(withVersion(og, env.VERSION?.id), request)   // /og.png, its font, the touch icon
    front ??= makeHandler(blocks, { role: "front", api: lb.api }, weather, geoid)
    const wu = (p: Promise<unknown>) => ctx.waitUntil(p)
    return withErrors(withVersion(await front(request, logs(env, wu, "front"), env.RUM && env.REQUEST_LOGS !== "off" ? rumPipelineSink(env.RUM, wu, env.VERSION?.id) : undefined), env.VERSION?.id), request)
  },
}
const logs = (env: Env, waitUntil: (p: Promise<unknown>) => void, role: string) =>
  env.LOGS && env.REQUEST_LOGS !== "off" ? pipelineSink(env.LOGS, waitUntil, env.VERSION?.id, role) : undefined

export class MetarFeed extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> { recordLoopbackTrace(request); return serveFeed(request, { fetch: (u, i) => fetch(u, i) }) }
}
