// Client disconnects are not server errors. Measured on prod (2026-10-31, scripts/obs/abort-probe.ts, abort-read.py): a
// client that leaves while the runtime is writing our response body (a JS stream: the homepage's streamed HTML, and every
// router response re-wrapped by toHandler) made the runtime log `Network connection lost.` at level error with an
// exception, mark the root span error, outcome ok, no response status. The live gate rolled ac16823e back on four of them.
//
// deliver(): the runtime never gets a JS stream. A known-length body is read and sent as bytes. A streamed body goes through
// an IdentityTransformStream we pump ourselves (in waitUntil): a failed write is then ours to see, the client went away,
// recorded as a countable event, never at error level:
//   - span `client.abort`: client.aborted=true, ephem.outcome=canceled, client.abort_phase=body, client.abort_bytes
//   - log  {"evt":"client_aborted","phase":"body","route","bytes","error"} (console.log: level info)
//   - the request row (Basin ephem_requests) gets error_tag "ClientAbort" (its schema is immutable: no new column)
// A failed READ of our own body is a server error and stays one: console.error {"response_stream_failed": …} and the
// response is aborted. A client that leaves before the response exists is cancelled by the runtime (outcome canceled), which
// the gate counts as an abort too (scripts/obs/gate_rules.py).
import type { Tracing } from "./trace.ts"

export interface Delivery { readonly response: Response; /** Settles once the body is written (false) or the client left (true). */ readonly aborted: Promise<boolean> }

const errText = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 200)

const native = typeof FixedLengthStream !== "undefined" && typeof IdentityTransformStream !== "undefined"   // false in Node (tests, dev)

/** The client went away: a countable event, never at error level. */
const recordAbort = (e: unknown, route: string | undefined, bytes: number, tracing: Tracing | undefined) => {
  console.log(JSON.stringify({ evt: "client_aborted", phase: "body", route: route ?? null, bytes, error: errText(e) }))
  try {
    const sp = tracing?.startSpan("client.abort")
    if (sp) { sp.setAttribute("client.aborted", true); sp.setAttribute("ephem.outcome", "canceled"); sp.setAttribute("client.abort_phase", "body"); sp.setAttribute("client.abort_bytes", bytes); if (route) sp.setAttribute("http.route", route); sp.end() }
  } catch { /* tracing must never fail a request */ }
  return true
}
const streamFailed = (e: unknown, route: string | undefined, bytes: number) =>
  console.error(JSON.stringify({ response_stream_failed: { route: route ?? null, bytes, error: errText(e) } }))

/** Known length (Content-Length, no content-encoding: every JSON answer): read it and answer with the bytes, which the
 *  runtime sends natively (no JS stream: a client leaving is not an exception; lab Worker, 2026-10-31). A FixedLengthStream
 *  written from waitUntil does not work: a client that has all N bytes hangs up before the runtime sees our close, and the
 *  runtime records outcome canceled, no status, on a delivered 200 (canaries a2d91cc3 and 7e2a3a79: 1 then 10 smoke
 *  requests). Unknown length (the streamed homepage, forwarded Api streams): IdentityTransformStream, chunk by chunk (the
 *  client cannot finish before our close: chunked framing ends with it). */
export const deliver = async (res: Response, waitUntil: (p: Promise<unknown>) => void, route: string | undefined, tracing: Tracing | undefined): Promise<Delivery> => {
  if (!res.body || res.webSocket) return { response: res, aborted: Promise.resolve(false) }
  const headers = new Headers(res.headers), init = { status: res.status, statusText: res.statusText, headers }
  const len = headers.get("content-length")
  if (len !== null && /^\d+$/.test(len) && !headers.has("content-encoding")) {
    let buf: ArrayBuffer
    try { buf = await res.arrayBuffer() } catch (e) { streamFailed(e, route, 0); throw e }   // a server error: the runtime answers 500
    headers.set("content-length", String(buf.byteLength))
    return { response: new Response(buf, init), aborted: Promise.resolve(false) }
  }
  headers.delete("content-length")
  const { readable, writable } = native ? new IdentityTransformStream() : new TransformStream<Uint8Array, Uint8Array>()
  const src = res.body.getReader(), out = writable.getWriter()
  let bytes = 0
  const pump = async (): Promise<boolean> => {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try { chunk = await src.read() } catch (e) {   // our own body failed: a server error
        streamFailed(e, route, bytes); await out.abort(e).catch(() => {}); return false
      }
      try {
        if (chunk.done) { await out.close(); return false }
        await out.write(chunk.value); bytes += chunk.value.byteLength
      } catch (e) {   // the client is gone
        src.cancel(e).catch(() => {})
        return recordAbort(e, route, bytes, tracing)
      }
    }
  }
  const aborted = pump()
  waitUntil(aborted)
  return { response: new Response(readable, init), aborted }
}

/** A request row that waits for delivery: emitted once the body is written or the client left (then error_tag ClientAbort). */
export const afterDelivery = <R extends { error_tag?: string }>(emit: (row: R) => void, waitUntil: (p: Promise<unknown>) => void) => {
  const box: { settle?: (aborted: boolean) => void } = {}
  const delivered = new Promise<boolean>(r => { box.settle = r })
  return {
    emit: (row: R) => waitUntil(delivered.then(aborted => { if (aborted) row.error_tag = "ClientAbort"; emit(row) })),
    settle: (p: Promise<boolean>) => { p.then(a => box.settle?.(a), () => box.settle?.(false)) },
  }
}
