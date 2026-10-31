// Effect v4 Tracer onto the platform's native Workers tracing (`tracing` from cloudflare:workers), so every Effect.withSpan,
// annotateCurrentSpan and HttpRouter request span lands in Workers traces with its attributes.
// Workers can only nest a span under the one active at creation (enterSpan callbacks), which does not fit fibers; so each Effect
// span becomes a startSpan child of the request span, carrying effect.span_id / effect.parent_id / effect.parent to rebuild the tree.
// Timers do not advance during pure compute in Workers, so compute spans read 0 ms: their attributes carry deterministic work counts.
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Tracer from "effect/Tracer"

interface WSpan {
  readonly isTraced: boolean
  setAttribute(k: string, v: string | number | boolean): unknown
  setStatus(s: { code: "ok" | "error" }): unknown
  end(): void
}
export interface Tracing {
  startSpan(name: string): WSpan
}

let tracing: Tracing | undefined
/** Install the Workers tracing API (the entry module does, once); absent in tests and the dev server, where spans stay in-memory. */
export const setTracing = (t: Tracing | undefined) => {
  tracing = t
}

/** Tracing must never fail a request: a throwing span call is dropped (and logged once). */
let warned = false
const safe = (f: () => unknown) => {
  try {
    f()
  } catch (e) {
    if (!warned) {
      warned = true
      console.error("tracing call failed", e)
    }
  }
}

const scalar = (v: unknown): string | number | boolean | undefined =>
  v === undefined || v === null
    ? undefined
    : typeof v === "string" || typeof v === "number" || typeof v === "boolean"
      ? v
      : typeof v === "bigint"
        ? Number(v)
        : JSON.stringify(v)

class WorkersSpan extends Tracer.NativeSpan {
  readonly w: WSpan
  constructor(options: ConstructorParameters<typeof Tracer.NativeSpan>[0], w: WSpan) {
    super(options)
    this.w = w
    const p = Option.getOrUndefined(options.parent)
    safe(() => {
      w.setAttribute("effect.span_id", this.spanId)
      if (p) {
        w.setAttribute("effect.parent_id", p.spanId)
        if (p._tag === "Span") w.setAttribute("effect.parent", p.name)
      }
    })
  }
  override attribute(key: string, value: unknown): void {
    super.attribute(key, value)
    const v = scalar(value)
    if (v !== undefined) safe(() => this.w.setAttribute(key, v))
  }
  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    super.end(endTime, exit)
    safe(() => this.w.setStatus({ code: Exit.isSuccess(exit) ? "ok" : "error" }))
    safe(() => this.w.end())
  }
}

export const WorkersTracer = Tracer.make({
  span: (options) => {
    let w: WSpan | undefined
    safe(() => {
      w = tracing?.startSpan(options.name)
    })
    return w ? new WorkersSpan(options, w) : new Tracer.NativeSpan(options)
  },
})
export const TracerLive = Layer.succeed(Tracer.Tracer, WorkersTracer)

/** W3C traceparent of the current Effect span (its trace id is the client's when the request carried a valid traceparent:
 *  HttpMiddleware.tracer parents the root span on it), for loopback fetches (BlockStore, MetarFeed). undefined if none. */
export const currentTraceparent = Effect.map(Effect.option(Effect.currentSpan), (sp) =>
  sp._tag === "Some" &&
  /^[0-9a-f]{32}$/.test(sp.value.traceId) &&
  /^[0-9a-f]{16}$/.test(sp.value.spanId) &&
  !/^0+$/.test(sp.value.traceId)
    ? `00-${sp.value.traceId}-${sp.value.spanId}-01`
    : undefined,
)

/** A loopback entrypoint (BlockStore, MetarFeed) has no Effect router: record the caller's trace context on a tiny span of
 *  its own (`loopback.trace`: client.trace_id, client.span_id) so its invocation joins the trace by id, not only by ray. */
export const recordLoopbackTrace = (req: Request) => {
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(req.headers.get("traceparent") ?? "")
  if (!m || !tracing || /^0+$/.test(m[1]!) || /^0+$/.test(m[2]!)) return
  safe(() => {
    const w = tracing!.startSpan("loopback.trace")
    w.setAttribute("client.trace_id", m[1]!)
    w.setAttribute("client.span_id", m[2]!)
    w.end()
  })
}
