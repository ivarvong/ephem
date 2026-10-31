// Client side of the unified trace (W3C Trace Context, docs/DESIGN.md §12.2): one trace id per page view, read from the
// document (meta → navigation serverTiming → fresh), and every fetch a child span: `traceparent: 00-<trace>-<new span>-01`,
// `tracestate: ephem=<document span>`. The record of every fetch is the RUM's (client/rum.ts) and the lab harness's
// (scripts/obs/journey.ts reads window.__ephemTrace).

export interface FetchRecord {
  readonly spanId: string; readonly parent: string | null; readonly url: string; readonly t0: number
  t1: number | null; status: number | null; ray: string | null; echo: string | null; used?: boolean; sent?: boolean
}
export interface PageTrace {
  readonly traceId: string
  /** the document's span (the server's root request span) */
  readonly parentSpanId: string | null
  readonly from: "meta" | "server-timing" | "fresh"
  readonly fetches: FetchRecord[]
}

export const hex = (n: number): string => {
  const b = new Uint8Array(n)
  crypto.getRandomValues(b)
  let s = ""
  for (const x of b) s += (x < 16 ? "0" : "") + x.toString(16)
  return s
}
const RE = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/

/** The page's trace context, from the document (pure: test/trace.test.ts). */
export const readTrace = (meta: string | null, serverTiming: ReadonlyArray<{ readonly name: string; readonly description: string }>): PageTrace => {
  let m = meta ? RE.exec(meta) : null, from: PageTrace["from"] = m ? "meta" : "fresh"
  for (const st of serverTiming) { if (m) break; if (st.name === "trace") { m = RE.exec(st.description || ""); if (m) from = "server-timing" } }
  if (m && (/^0+$/.test(m[1]!) || /^0+$/.test(m[2]!))) { m = null; from = "fresh" }
  return { traceId: m ? m[1]! : hex(16), parentSpanId: m ? m[2]! : null, from, fetches: [] }
}

const pageTrace = (): PageTrace => {
  let meta: string | null = null, st: ReadonlyArray<PerformanceServerTiming> = []
  try { meta = document.querySelector('meta[name="traceparent"]')?.getAttribute("content") ?? null } catch { /* no DOM */ }
  try { st = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.serverTiming ?? [] } catch { /* no timing */ }
  return readTrace(meta, st)
}

declare global { interface Window { __ephemTrace?: PageTrace } }
let current: PageTrace | undefined
/** This page view's trace (created on first use; exposed read-only to the lab harness as window.__ephemTrace). */
export const getTrace = (): PageTrace => {
  if (!current) { current = pageTrace(); window.__ephemTrace = current }
  return current
}

/** fetch with this page view's trace context; records the fetch for RUM. */
export const tfetch = (url: string, init: RequestInit = {}): Promise<Response> => {
  const trace = getTrace(), sid = hex(8), rec: FetchRecord = { spanId: sid, parent: trace.parentSpanId, url, t0: performance.now(), t1: null, status: null, ray: null, echo: null }
  trace.fetches.push(rec)
  const h = new Headers(init.headers ?? {})
  h.set("traceparent", "00-" + trace.traceId + "-" + sid + "-01")
  if (trace.parentSpanId) h.set("tracestate", "ephem=" + trace.parentSpanId)
  return fetch(url, { ...init, headers: h }).then(r => {
    rec.t1 = performance.now(); rec.status = r.status; rec.ray = r.headers.get("cf-ray"); rec.echo = r.headers.get("x-ephem-trace")
    return r
  }, (e: unknown) => { rec.t1 = performance.now(); rec.status = 0; throw e })
}
