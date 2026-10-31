// The page head's preview tags (src/og.ts ogHead). For a link-preview fetcher (og.ts PREVIEW_BOT: iMessage, Slack, X,
// Facebook, …) the head first reads the live numbers for og:description and og:image:alt, in-process as the page's embeds do
// (src/embed.ts routeText: /v1/position now, /v1/day today and tomorrow), within OG_LIVE_MS; a person's page never waits.
import * as Effect from "effect/Effect"
import type * as HttpRouter from "effect/http/HttpRouter"
import type * as HttpServerRequest from "effect/http/HttpServerRequest"
import { routeText } from "./embed.ts"
import { ogHead, PREVIEW_BOT, type OgHeadInput } from "./og.ts"

export const OG_LIVE_MS = 1200
/** The public origin of the page request (the web Request's own URL; the router's URL can lack the host). */
export const originOf = (req: HttpServerRequest.HttpServerRequest, url: URL) => {
  try {
    return new URL((req.source as { url: string }).url).origin
  } catch {
    return url.origin
  }
}
type V = OgHeadInput["v"]
const localDate = (ms: number, tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(ms))

export const ogHeadFor = (
  router: HttpRouter.HttpRouter,
  req: HttpServerRequest.HttpServerRequest,
  origin: string,
  v: V,
  traceparent?: string,
) =>
  Effect.gen(function* () {
    const now = Date.now(),
      ua = (req.headers as Readonly<Record<string, string | undefined>>)["user-agent"] ?? ""
    if (!PREVIEW_BOT.test(ua)) return ogHead({ origin, v, now })
    const ll = { lat: v.lat.toFixed(5), lon: v.lon.toFixed(5) },
      today = localDate(now, v.tz)
    const tomorrow = new Date(Date.parse(today + "T00:00:00Z") + 864e5).toISOString().slice(0, 10)
    const json = (path: string, q: Record<string, string>) =>
      routeText(router, req, path, q, traceparent).pipe(
        Effect.map((r) => (r.status === 200 ? JSON.parse(r.text) : null)),
      )
    const live = yield* Effect.all(
      [
        json("/v1/position", ll),
        json("/v1/day", { ...ll, date: today, tz: v.tz }),
        json("/v1/day", { ...ll, date: tomorrow, tz: v.tz }),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map(([pos, d0, d1]) =>
        pos && d0 ? { sun: pos.sun, moon: pos.moon, events: [...d0.events, ...(d1?.events ?? [])] } : null,
      ),
      Effect.timeoutOption(OG_LIVE_MS),
      Effect.map((o) => (o._tag === "Some" ? o.value : null)),
      Effect.catchCause(() => Effect.succeed(null)),
      Effect.withSpan("home.og"),
    )
    yield* Effect.annotateCurrentSpan({ "home.og_bot": true, "home.og_live": live != null })
    return ogHead({ origin, v, now, live })
  })
