// GET /: the live sky over wherever the visitor is. Location comes from Cloudflare (request.cf) unless ?lat&lon override it.
// The first frame is the server's: the document (rendered by @ephem/web: packages/web/src/server/home.tsx) is flushed at once,
// then this Worker's own API answers, computed in-process through the router (src/embed.ts), stream in as JSON. The browser
// hydrates the page, boots from those answers and takes over computing the sky with the same @ephem/core
// (/assets/de440/<sha16>/<i>: src/sky-assets.ts).
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { isValidZone } from "@ephem/core"
import { coordQuery, dayQuery, homeCsp, localDate, nextDate, renderHomeBody, renderHomeHead, trackQuery, type HomeHead, type Visitor } from "@ephem/web/server"
import { DIN_LICENSE } from "./din.ts"
import { routeText, streamHtml } from "./embed.ts"
import { ogHeadFor, originOf } from "./og-head.ts"
import { documentTrace, documentTraceHeaders, parseTraceparent } from "./clienttrace.ts"
import { DE440_ASSET_BASE } from "./sky-assets.ts"
export type { Visitor }

interface CfLocation {
  readonly latitude?: string; readonly longitude?: string; readonly city?: string; readonly region?: string
  readonly country?: string; readonly timezone?: string; readonly colo?: string
}

const DEFAULT = { lat: 40.6892, lon: -74.0445, place: "Liberty Island, New York", city: "Liberty Island", tz: "America/New_York" } as const
const inRange = (x: number, m: number) => Number.isFinite(x) && Math.abs(x) <= m
const zone = (tz: string | null | undefined, fallback: string) => (tz && isValidZone(tz) ? tz : fallback)
const coords = (lat: number, lon: number) => `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(2)}° ${lon >= 0 ? "E" : "W"}`

/** Where to compute for: explicit ?lat&lon, else Cloudflare's IP geolocation, else Liberty Island. `city` is the short title. */
export const visitor = (url: URL, cf: CfLocation | undefined): Visitor => {
  const colo = cf?.colo ?? null
  const qLat = Number(url.searchParams.get("lat")), qLon = Number(url.searchParams.get("lon"))
  if (url.searchParams.has("lat") && url.searchParams.has("lon") && inRange(qLat, 90) && inRange(qLon, 180)) {
    const place = (url.searchParams.get("place") ?? "").slice(0, 80) || coords(qLat, qLon)
    return { lat: qLat, lon: qLon, place, city: place, tz: zone(url.searchParams.get("tz"), zone(cf?.timezone, "UTC")), colo, source: "query" }
  }
  const lat = Number(cf?.latitude), lon = Number(cf?.longitude)
  if (cf?.latitude && cf.longitude && inRange(lat, 90) && inRange(lon, 180)) {
    const place = [cf.city, cf.region && cf.region !== cf.city ? cf.region : undefined, cf.country].filter(Boolean).join(", ") || coords(lat, lon)
    return { lat, lon, place, city: cf.city || place, tz: zone(cf.timezone, "UTC"), colo, source: "cloudflare" }
  }
  return { ...DEFAULT, colo, source: "default" }
}

/** The queries the page's first load makes, built by the same functions the browser builds them with (@ephem/web lib/time.ts),
 *  so an embedded answer is the one the browser would have fetched: lat/lon at 5 decimals, the track window from this UTC day,
 *  today in tz. */
export const initialQueries = (v: Visitor, now: number, at?: number) => {
  const q = coordQuery(v.lat, v.lon), t = at ?? now, today = localDate(t, v.tz)
  return {
    // live: no time parameter (computed here, never cached); ?at: that instant (a deterministic, cached answer)
    "ephem-position": ["/v1/position", at == null ? q : { ...q, time: new Date(at).toISOString() }],
    "ephem-track": ["/v1/track", trackQuery(v.lat, v.lon, t)],
    "ephem-day": ["/v1/day", dayQuery(v.lat, v.lon, today, v.tz)],
    "ephem-tomorrow": ["/v1/day", dayQuery(v.lat, v.lon, nextDate(today), v.tz)],   // the countdown's next event when today's are past
    "ephem-magnetic": ["/v1/magnetic", q],   // the declination, so MAG shows with the first numbers (it used to wait for weather)
  } as const satisfies Record<string, readonly [string, Record<string, string>]>
}

/** Response headers of every HTML page: its CSP, and no sniffing. */
export const pageHeaders = (csp: string): Record<string, string> => ({ "content-security-policy": csp, "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin" })

/** ?at=<ISO> (debug: a frozen page clock, for deterministic screenshots of any sky state), as the page parses it. */
export const atOf = (url: URL): number | undefined => { const t = Date.parse(url.searchParams.get("at") ?? ""); return Number.isFinite(t) && t > 63e9 && t < 5.6e12 ? t : undefined }
/** A phone (the first frame's layout): Chrome's low-entropy client hint, else the user agent. */
export const isMobile = (h: Readonly<Record<string, string | undefined>>): boolean =>
  h["sec-ch-ua-mobile"] === "?1" || (h["sec-ch-ua-mobile"] !== "?0" && /Mobi|iPhone|iPod|Android/.test(h["user-agent"] ?? ""))

/** An answer slower than this is left out and the page fetches it (a cold Api isolate's /v1/day or /v1/track MISS is ~200–350 ms). */
const EMBED_TIMEOUT_MS = 1500
// GET /: the head and the header are flushed at once; the first-load answers are computed in-process through the router
// (src/embed.ts), then the first frame is rendered from them (@ephem/web renderHomeBody: the sky, the numbers, the timeline),
// followed by the answers themselves and </body>. An answer that is not a 200 is left out and the page fetches it.
export const Home = HttpRouter.use(router => Effect.gen(function* () {
  // the licence of the page's font (packages/web/src/fonts, D-DIN subset), as the OFL asks
  yield* router.add("GET", "/licenses/din.txt", HttpServerResponse.text(DIN_LICENSE, { headers: { "cache-control": "public, max-age=86400" } }))
  yield* router.add("GET", "/", req => Effect.gen(function* () {
    const tid = yield* documentTrace(req)   // on the root span; the page's fetches are its children (src/clienttrace.ts)
    return yield* Effect.gen(function* () {
      const url = Option.getOrElse(HttpServerRequest.toURL(req), () => new URL("http://localhost/"))
      const v = visitor(url, (req.source as { cf?: CfLocation }).cf)
      yield* Effect.annotateCurrentSpan({ "home.source": v.source, "home.colo": v.colo ?? "", "home.tz": v.tz })
      const now = Date.now(), at = atOf(url)
      const head: HomeHead = { v, traceparent: parseTraceparent(tid.traceparent) ? tid.traceparent : undefined, synthetic: tid.synthetic, blocks: DE440_ASSET_BASE, now, at,
        origin: originOf(req, url), mobile: isMobile(req.headers as Readonly<Record<string, string | undefined>>) }
      const embeds = Effect.forEach(Object.entries(initialQueries(v, now, at)), ([id, [path, query]]) =>
        routeText(router, req, path, query, tid.traceparent).pipe(Effect.timeoutOption(EMBED_TIMEOUT_MS),
          Effect.map(o => (o._tag === "Some" && o.value.status === 200 ? [[id, o.value.text] as const] : []))), { concurrency: "unbounded" })
      const tail = embeds.pipe(
        Effect.map(parts => parts.flat()),
        Effect.tap(parts => Effect.annotateCurrentSpan({ "home.embedded": parts.length })),
        Effect.withSpan("home.embed"),
        Effect.map(parts => renderHomeBody(head, parts)),
        Effect.catchCause(() => Effect.succeed(renderHomeBody(head, []))))   // never fails: the page fetches what is missing
      const og = yield* ogHeadFor(router, req, originOf(req, url), v, tid.traceparent)   // link-preview tags (src/og-head.ts)
      return yield* streamHtml(renderHomeHead({ ...head, og }), tail, { "cache-control": "private, no-store", ...documentTraceHeaders(tid), ...pageHeaders(homeCsp()) })
    }).pipe(Effect.withSpan("home"))
  }))
}))
