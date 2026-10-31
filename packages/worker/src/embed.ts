// Initial data in the page, streamed (shared by the pages: /instrument; the homepage may adopt it). A page's first data used
// to cost a second network round trip (document → boot script → API fetch): ~570 ms of latency on Fast 3G for ~2 ms of
// server CPU. Instead the page handler runs the API routes in-process (the same router, the same middleware: a live
// /v1/position is computed here, /v1/day goes through Gateway to the cached Api, exactly as the browser's fetch would) and
// embeds their response bodies verbatim as `<script type="application/json" id="…">`, so the numbers are the API's by
// construction. The response streams: the head (CSS, fonts, boot script) is flushed at once, so the browser parses and
// styles while the server waits for the data; the rest (body + data + glue) follows when the data is in.
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Stream from "effect/Stream"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"

/** Request headers an in-process call inherits from the page request: cf-ray (joins rows), the version override (pins it),
 *  the synthetic markers, and the document's trace context. */
const INHERIT = ["cf-ray", "cloudflare-workers-version-overrides", "x-ephem-load", "x-ephem-smoke"]

/** GET `path?query` on the router itself, in the caller's fiber (as MCP's tools do); returns status and the body text. */
export const routeText = (router: HttpRouter.HttpRouter, req: HttpServerRequest.HttpServerRequest, path: string,
  query: Record<string, string>, traceparent?: string) => Effect.gen(function* () {
  const h = req.headers as Readonly<Record<string, string | undefined>>, headers: Record<string, string> = {}
  for (const k of INHERIT) if (h[k]) headers[k] = h[k]!
  if (traceparent) headers["traceparent"] = traceparent
  const inner = HttpServerRequest.fromWeb(new Request(`http://ephem.internal${path}?${new URLSearchParams(query)}`, { headers }))
  const res = yield* router.asHttpEffect().pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, inner), Effect.scoped)
  const web = HttpServerResponse.toWeb(res)
  return { status: web.status, text: yield* Effect.promise(() => web.text()) }
})

/** `<script type="application/json" id>` holding JSON text; `<` is escaped (\u003c is the same JSON), so no `</script>`. */
export const jsonScript = (id: string, json: string): string =>
  `<script type="application/json" id="${id}">${json.replace(/</g, "\\u003c")}</script>`

/** A streamed HTML response: `head` is sent at once, `tail` when it has run (forked now, so it starts at once too). The
 *  tail must not fail: give it its own fallback. */
export const streamHtml = (head: string, tail: Effect.Effect<string>, headers: Record<string, string>) => Effect.gen(function* () {
  const fiber = yield* Effect.forkDetach(tail)
  const enc = new TextEncoder()
  const body = Stream.concat(Stream.make(enc.encode(head)), Stream.fromEffect(Fiber.join(fiber).pipe(Effect.map(s => enc.encode(s)))))
  return HttpServerResponse.stream(body, { contentType: "text/html; charset=utf-8", headers })
})

/** Browser side: the embedded JSON by id, or null (missing, empty, unparsable). */
export const READ_EMBED_JS = String.raw`
function __embed(id) { try { var el = document.getElementById(id); return el && el.textContent ? JSON.parse(el.textContent) : null; } catch (e) { return null; } }
`
