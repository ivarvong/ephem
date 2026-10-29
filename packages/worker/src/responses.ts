// Cache-Control per route, and the front door → Api forwarding. No Cache API: caching is Workers Caching in front of the
// cache-enabled entrypoints (cloudflare.config.ts `exports`), driven only by the Cache-Control set here.
//
//   eyeball ─▶ default entrypoint (cache OFF: always runs, so traces, logs, request.cf and `/` stay per request)
//                 ├─ GET /v1/* except live ─▶ loopback.ts api: Api, cf.cacheKey = /v<CACHE_VERSION><path+sorted query>
//                 │                          (cache ON; crossVersionCache is on, so answers survive deploys until the
//                 │                           tag is bumped; test/golden.test.ts enforces the bump)
//                 └─ live (position / magnetic without time): computed here; caching an answer about "now" buys nothing
//
// The same router runs in both entrypoints; the Edge role says which side of the loopback this is.
import { Context, Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"

export const IMMUTABLE = "public, max-age=31536000, immutable"
const NO_STORE = "no-store"

/** Where this router runs. `local`: tests and the dev server (everything in-process, outward headers only). */
export type Role =
  | { readonly role: "local" }
  | { readonly role: "api" }
  | { readonly role: "front"; readonly api: (pathAndQuery: string, init: { method: string; headers: Record<string, string> }) => Promise<Response> }   // loopback.ts api
export class Edge extends Context.Service<Edge, Role>()("@ephem/worker/Edge") {}

/** A pure function of the query (and CACHE_VERSION, which is in the Api's cache key), so a year is safe. */
export const deterministic = (url: URL): boolean =>
  url.pathname === "/v1/day" || url.pathname === "/v1/alignment" ||
  (url.pathname === "/v1/crossing" && (url.searchParams.has("start") || url.searchParams.has("date"))) ||
  ((url.pathname === "/v1/position" || url.pathname === "/v1/magnetic") && url.searchParams.has("time"))

/** What the Api entrypoint tells Workers Caching. Weather: stored but stale at once (max-age=0), then served stale for up
 *  to 5 min while one background request refreshes it, so a hot key answers from cache and is at most one request behind
 *  (plus the feed's own 60 s). Live position / magnetic are not forwarded (see `forwards`); API_LIVE covers a direct call.
 *  Measurements: docs/telemetry_and_profiling.md "Caching". */
export const API_LIVE = "public, max-age=0"
export const API_WEATHER = "public, max-age=0, stale-while-revalidate=300, stale-if-error=3600"
export const internalCacheControl = (status: number, url: URL): string | undefined => {
  if (!url.pathname.startsWith("/v1/")) return undefined
  if (status !== 200) return NO_STORE
  if (deterministic(url)) return IMMUTABLE
  return url.pathname === "/v1/weather" ? API_WEATHER : API_LIVE
}

/** What browsers and other downstream caches see from the (uncached) front door. */
export const outwardCacheControl = (status: number, url: URL): string | undefined => {
  if (url.pathname === "/") return "private, no-store"   // the sky at request.cf's location: never shared
  if (url.pathname === "/docs" || url.pathname === "/openapi.json") return "public, max-age=300"
  if (!url.pathname.startsWith("/v1/")) return undefined
  if (status !== 200) return NO_STORE
  if (deterministic(url)) return IMMUTABLE
  if (url.pathname === "/v1/weather") return "private, max-age=30"
  if (url.pathname === "/v1/magnetic") return "public, max-age=3600"   // ~0.1°/year
  return NO_STORE   // position now, health
}

/** Forwarded to the Api: path plus the query with parameters sorted, so ?a&b and ?b&a share one cache entry. */
export const canonical = (url: URL): string => {
  const q = new URLSearchParams([...url.searchParams].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))).toString()
  return url.pathname + (q ? `?${q}` : "")
}
/** Live = a question about "now" (position / magnetic without time). max-age=0 forwarding measured +35 ms server p50
 *  and no sequential hits on c72a360c, so these run in the front door. Weather is forwarded (SWR for hot keys). */
export const live = (url: URL) => (url.pathname === "/v1/position" || url.pathname === "/v1/magnetic") && !url.searchParams.has("time")
export const forwards = (method: string, url: URL) => (method === "GET" || method === "HEAD") && url.pathname.startsWith("/v1/") && !live(url)

const withCacheControl = (res: HttpServerResponse.HttpServerResponse, cc: string | undefined) =>
  cc ? HttpServerResponse.setHeader(res, "cache-control", cc) : res

export const Gateway = HttpRouter.middleware(Effect.gen(function* () {
  const edge = yield* Edge
  return http => Effect.gen(function* () {
    const req = yield* HttpServerRequest.HttpServerRequest
    const url = new URL(req.originalUrl, "http://localhost")
    if (edge.role === "front" && forwards(req.method, url)) {
      // x-ephem-ray joins the Api invocation's log row to this one; request headers outside the documented set are not in the key.
      const ray = req.headers["cf-ray"], headers: Record<string, string> = ray ? { "x-ephem-ray": ray } : {}
      const key = canonical(url)
      const forwarded = yield* Effect.tryPromise(() => edge.api(key, { method: req.method, headers })).pipe(
        Effect.tap(r => Effect.annotateCurrentSpan({ "ephem.api_cache": r.headers.get("cf-cache-status") ?? "NONE", "http.status_code": r.status })),
        Effect.withSpan("api.fetch", { attributes: { "ephem.api_key": key } }),
        Effect.option)
      if (forwarded._tag === "Some") {
        const r = forwarded.value, status = r.headers.get("cf-cache-status") ?? "NONE"
        yield* Effect.annotateCurrentSpan({ "ephem.api_cache": status })
        const h = new Headers(r.headers); h.delete("cf-cache-status"); h.set("x-ephem-cache", status)
        const cc = outwardCacheControl(r.status, url); if (cc) h.set("cache-control", cc)
        return HttpServerResponse.fromWeb(new Response(r.body, { status: r.status, statusText: r.statusText, headers: h }))
      }
      // The loopback itself failed (not an error answer from the Api): compute here rather than fail the request.
      yield* Effect.annotateCurrentSpan({ "ephem.api_cache": "LOOPBACK_ERROR" })
      const res = yield* http
      return withCacheControl(HttpServerResponse.setHeader(res, "x-ephem-cache", "LOOPBACK_ERROR"), outwardCacheControl(res.status, url))
    }
    if (edge.role === "front" && url.pathname.startsWith("/v1/")) yield* Effect.annotateCurrentSpan({ "ephem.api_cache": "LOCAL" })
    const res = yield* http
    return withCacheControl(res, edge.role === "api" ? internalCacheControl(res.status, url) : outwardCacheControl(res.status, url))
  })
}), { global: true })

/** The Api entrypoint's last word: a response with no Cache-Control (e.g. the router's own 404, which no middleware sees)
 *  would get Workers Caching's heuristic TTL (404: 3 min, verified HIT on fd72f501); make it no-store instead. */
export const defaultNoStore = (res: Response): Response => {
  if (res.headers.has("cache-control")) return res
  const h = new Headers(res.headers); h.set("cache-control", NO_STORE)
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h })
}
