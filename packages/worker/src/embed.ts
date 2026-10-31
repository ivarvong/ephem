// Initial data in the page, streamed (used by the homepage). A page's first data used
// to cost a second network round trip (document → boot script → API fetch): ~570 ms of latency on Fast 3G for ~2 ms of
// server CPU. Instead the page handler runs the API routes in-process (the same router, the same middleware: a live
// /v1/position is computed here, /v1/day goes through Gateway to the cached Api, exactly as the browser's fetch would) and
// embeds their response bodies verbatim as `<script type="application/json" id="…">`, so the numbers are the API's by
// construction. The response streams: the head (CSS, fonts, boot script) is flushed at once, so the browser parses and
// styles while the server waits for the data; the rest (body + data + glue) follows when the data is in.
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Stream from "effect/Stream"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { IN_PROCESS_ORIGIN } from "./clienttrace.ts"

/** Request headers an in-process call inherits from the page request: cf-ray (joins rows), the version override (pins it),
 *  the synthetic markers, and the document's trace context. */
const INHERIT = ["cf-ray", "cloudflare-workers-version-overrides", "x-ephem-load", "x-ephem-smoke"]

/** GET `path?query` on the router itself, in the caller's fiber (as MCP's tools do); returns status and the body text. */
export const routeText = (router: HttpRouter.HttpRouter, req: HttpServerRequest.HttpServerRequest, path: string,
  query: Record<string, string>, traceparent?: string) => Effect.gen(function* () {
  const h = req.headers as Readonly<Record<string, string | undefined>>, headers: Record<string, string> = {}
  for (const k of INHERIT) if (h[k]) headers[k] = h[k]!
  if (traceparent) headers["traceparent"] = traceparent
  const inner = HttpServerRequest.fromWeb(new Request(`${IN_PROCESS_ORIGIN}${path}?${new URLSearchParams(query)}`, { headers }))
  const res = yield* router.asHttpEffect().pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, inner), Effect.scoped)
  const web = HttpServerResponse.toWeb(res)
  return { status: web.status, text: yield* Effect.promise(() => web.text()) }
})

/** `<script type="application/json" id>` holding JSON text; `<` is escaped (\u003c is the same JSON), so no `</script>`. */
export const jsonScript = (id: string, json: string): string =>
  `<script type="application/json" id="${id}">${json.replace(/</g, "\\u003c")}</script>`

/** Where a tail splits into chunks of its own: everything after it is written separately, so what comes before is flushed and
 *  parsed without waiting (the homepage sends its inline font after the answers that boot it). */
export const FLUSH = "<!--flush-->"

/** The inline <script> and <style> blocks of a head without comment lines and indentation (the homepage's 98 KB head → ~60).
 *  Only whole lines that start with // are dropped from scripts (no string in them spans lines), and block comments from
 *  styles; JSON scripts and markup are untouched. */
export const minifyInline = (h: string): string =>
  h.replace(/(<script>)([\s\S]*?)(<\/script>)|(<style>)([\s\S]*?)(<\/style>)/g, (_m, a, js, b, c, css, d) => js != null
    ? a + js.split("\n").map((l: string) => l.trim()).filter((l: string) => l && !l.startsWith("//")).join("\n") + b
    : c + css.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l: string) => l.trim()).filter(Boolean).join("\n") + d)

/** A streamed HTML response: `head` (minified) is sent at once, `tail` when it has run (forked now, so it starts at once
 *  too), in chunks split at FLUSH. The tail must not fail: give it its own fallback.
 *  `html.stream` span: opened with the response, ended when the body stream has handed its last chunk to the runtime (or was
 *  cancelled), so a streamed document's body end is recorded (the request span closes when the handler returns, at the first
 *  byte). Workers' clock only advances on I/O, so the end reads the last I/O before the close. Attributes: html.chunks,
 *  html.bytes, html.stream_outcome (done / interrupted). */
export const streamHtml = (head: string, tail: Effect.Effect<string>, headers: Record<string, string>) => Effect.gen(function* () {
  const span = yield* Effect.makeSpan("html.stream")
  const fiber = yield* Effect.forkDetach(tail)
  const enc = new TextEncoder()
  let chunks = 0, bytes = 0
  const body = Stream.concat(Stream.make(enc.encode(minifyInline(head))),
    Stream.fromEffect(Fiber.join(fiber)).pipe(Stream.flatMap(s => Stream.fromIterable(s.split(FLUSH).map(p => enc.encode(p)))))).pipe(
    Stream.tap(b => Effect.sync(() => { chunks++; bytes += b.byteLength })),
    Stream.onExit(exit => Effect.flatMap(Clock.currentTimeNanos, now => Effect.sync(() => {
      span.attribute("html.chunks", chunks); span.attribute("html.bytes", bytes)
      span.attribute("html.stream_outcome", Exit.isSuccess(exit) ? "done" : "interrupted")
      span.end(now, exit)
    }))))
  return HttpServerResponse.stream(body, { contentType: "text/html; charset=utf-8", headers })
})

/** Browser side: the embedded JSON by id, or null (missing, empty, unparsable). */
export const READ_EMBED_JS = String.raw`
function __embed(id) { try { var el = document.getElementById(id); return el && el.textContent ? JSON.parse(el.textContent) : null; } catch (e) { return null; } }
`
