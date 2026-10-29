// Effect v4 Tracer onto the platform's native Workers tracing (`tracing` from cloudflare:workers), so every Effect.withSpan,
// annotateCurrentSpan and HttpRouter request span lands in Workers traces with its attributes.
// Workers can only nest a span under the one active at creation (enterSpan callbacks), which does not fit fibers; so each Effect
// span becomes a startSpan child of the request span, carrying effect.span_id / effect.parent_id / effect.parent to rebuild the tree.
// Timers do not advance during pure compute in Workers, so compute spans read 0 ms: their attributes carry deterministic work counts.
import { Exit, Layer, Option, Tracer } from "effect"

interface WSpan { readonly isTraced: boolean; setAttribute(k: string, v: string | number | boolean): unknown; setStatus(s: { code: "ok" | "error" }): unknown; end(): void }
export interface Tracing { startSpan(name: string): WSpan }

let tracing: Tracing | undefined
/** Install the Workers tracing API (the entry module does, once); absent in tests and the dev server, where spans stay in-memory. */
export const setTracing = (t: Tracing | undefined) => { tracing = t }

/** Tracing must never fail a request: a throwing span call is dropped (and logged once). */
let warned = false
const safe = (f: () => unknown) => { try { f() } catch (e) { if (!warned) { warned = true; console.error("tracing call failed", e) } } }

const scalar = (v: unknown): string | number | boolean | undefined =>
  v === undefined || v === null ? undefined : typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : typeof v === "bigint" ? Number(v) : JSON.stringify(v)

class WorkersSpan extends Tracer.NativeSpan {
  readonly w: WSpan
  constructor(options: ConstructorParameters<typeof Tracer.NativeSpan>[0], w: WSpan) {
    super(options); this.w = w
    const p = Option.getOrUndefined(options.parent)
    safe(() => {
      w.setAttribute("effect.span_id", this.spanId)
      if (p) { w.setAttribute("effect.parent_id", p.spanId); if (p._tag === "Span") w.setAttribute("effect.parent", p.name) }
    })
  }
  override attribute(key: string, value: unknown): void {
    super.attribute(key, value)
    const v = scalar(value); if (v !== undefined) safe(() => this.w.setAttribute(key, v))
  }
  override end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    super.end(endTime, exit)
    safe(() => this.w.setStatus({ code: Exit.isSuccess(exit) ? "ok" : "error" })); safe(() => this.w.end())
  }
}

export const WorkersTracer = Tracer.make({
  span: options => {
    let w: WSpan | undefined
    safe(() => { w = tracing?.startSpan(options.name) })
    return w ? new WorkersSpan(options, w) : new Tracer.NativeSpan(options)
  },
})
export const TracerLive = Layer.succeed(Tracer.Tracer, WorkersTracer)
