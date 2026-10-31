// Production RUM (docs/telemetry_and_profiling.md "Page views"): navigation and every resource (Resource Timing +
// serverTiming), FCP, LCP, CLS, INP, long animation frames, every fetch with its span ids, and the page's app spans, batched to
// POST /rum (validated and stored by the Worker, packages/worker/src/rum.ts). sendBeacon on pagehide / hidden, keepalive fetch
// every 15 s and 2 s after data-ready. DNT / GPC and unsampled traceparents send nothing.
import { getTrace, hex, type FetchRecord, type PageTrace } from "./trace.ts"

export interface Rum {
  readonly off: string | null
  /** an app span from t0 to t1 (ms since navigation start); t1 null = a mark */
  span(name: string, t0: number, t1: number | null, detail?: string): void
  interaction(name: string, t0: number, t1: number, detail?: string): void
  mark(name: string, detail?: string): void
  flush(final: boolean): void
}
declare global { interface Window { __rum?: Rum } }

type Row = Record<string, unknown>
const noop = () => {}
const r1 = (x: number | null | undefined) => (x == null ? undefined : Math.round(x * 10) / 10)

const off = (T: PageTrace | undefined): string | null => {
  const N = navigator as Navigator & { globalPrivacyControl?: boolean }
  if (!T) return "no-trace"
  if (N.doNotTrack === "1" || (window as Window & { doNotTrack?: string }).doNotTrack === "1" || N.globalPrivacyControl === true) return "privacy"
  return null
}

/** Start RUM for this page view (once). */
export const startRum = (): Rum => {
  if (window.__rum) return window.__rum
  const T = getTrace()
  let why = off(T)
  let tp: string | null = null
  try { tp = document.querySelector('meta[name="traceparent"]')?.getAttribute("content") ?? null } catch { /* no DOM */ }
  if (!why) { if (!tp || !tp.includes(T.traceId)) tp = "00-" + T.traceId + "-" + (T.parentSpanId || hex(8)) + "-01"; if (!tp.endsWith("-01")) why = "unsampled" }
  if (why || !window.PerformanceObserver) {
    const r: Rum = { off: why || "unsupported", span: noop, mark: noop, interaction: noop, flush: noop }
    window.__rum = r
    return r
  }
  const SYN = !!document.querySelector('meta[name="ephem-synthetic"]')   // the document request was synthetic (src/clienttrace.ts)
  const buf: Row[] = [], DOC = T.parentSpanId ?? undefined
  let seq = 0
  const add = (o: Row) => { if (buf.length < 600) buf.push(o) }
  const sid = () => hex(8)
  const stOf = (e: PerformanceResourceTiming) => {
    try { return (e.serverTiming || []).map(s => s.name + (s.description ? ';desc="' + s.description + '"' : "") + (s.duration ? ";dur=" + s.duration : "")).join(", ").slice(0, 400) } catch { return undefined }
  }
  const phases = (e: PerformanceResourceTiming) => {
    const tls = e.secureConnectionStart > 0 ? e.connectEnd - e.secureConnectionStart : 0
    return [r1(e.domainLookupEnd - e.domainLookupStart), r1((e.secureConnectionStart > 0 ? e.secureConnectionStart : e.connectEnd) - e.connectStart), r1(tls),
      e.responseStart > 0 ? r1(e.responseStart - e.requestStart) : undefined, e.responseStart > 0 ? r1(e.responseStart - e.startTime) : undefined, e.responseStart > 0 ? r1(e.responseEnd - e.responseStart) : undefined]
  }
  const fetchFor = (u: string, t: number): FetchRecord | null => {
    for (const f of T.fetches) if (!f.used && f.url && new URL(f.url, location.href).href === u && Math.abs(f.t0 - t) < 50) { f.used = true; return f }
    return null
  }
  const resource = (e: PerformanceResourceTiming) => {
    let u: URL
    try { u = new URL(e.name, location.href) } catch { return }
    if (u.origin === location.origin && u.pathname === "/rum") return
    const f = e.initiatorType === "fetch" ? fetchFor(u.href, e.startTime) : null
    add({ k: "resource", n: e.initiatorType || "other", sid: f ? f.spanId : sid(), pid: DOC, t: r1(e.startTime), d: r1(e.duration), tg: u.origin === location.origin ? u.pathname : "external",
      ph: phases(e), b: e.transferSize, st: (e as PerformanceResourceTiming & { responseStatus?: number }).responseStatus, pr: e.nextHopProtocol, sv: stOf(e), r: f ? f.ray : undefined })
  }
  const obs = <E extends PerformanceEntry>(type: string, fn: (e: E) => void, opts: Record<string, unknown> = {}) => {
    try { const o = new PerformanceObserver(l => l.getEntries().forEach(e => fn(e as E))); o.observe({ type, buffered: true, ...opts }); return o } catch { return null }
  }
  const nav = performance.getEntriesByType("navigation")[0] as (PerformanceNavigationTiming & { responseStatus?: number }) | undefined
  if (nav) add({ k: "navigation", n: (nav.type || "navigate").replace(/_/g, "-"), sid: DOC || sid(), pid: undefined, t: 0, d: r1(nav.duration || nav.loadEventEnd), tg: location.pathname,
    ph: phases(nav), b: nav.transferSize, st: nav.responseStatus, pr: nav.nextHopProtocol, sv: stOf(nav), v: r1(nav.domContentLoadedEventEnd) })
  obs<PerformanceResourceTiming>("resource", resource)
  obs<PerformanceEntry>("paint", e => add({ k: "paint", n: e.name === "first-contentful-paint" ? "fcp" : "fp", sid: sid(), pid: DOC, t: r1(e.startTime) }))
  let lcp: (PerformanceEntry & { element?: Element | null }) | null = null
  obs<PerformanceEntry>("largest-contentful-paint", e => { lcp = e })
  let cls = 0, sess = 0, last = 0, first = 0
  obs<PerformanceEntry & { hadRecentInput: boolean; value: number }>("layout-shift", e => {
    if (e.hadRecentInput) return
    if (e.startTime - last > 1000 || e.startTime - first > 5000) { sess = 0; first = e.startTime }
    sess += e.value; last = e.startTime
    if (sess > cls) cls = sess
  })
  const inter: Record<number, { d: number; t: number; n: string }> = {}
  obs<PerformanceEventTiming & { interactionId?: number }>("event", e => {
    if (!e.interactionId) return
    const p = inter[e.interactionId]
    if (!p || e.duration > p.d) inter[e.interactionId] = { d: e.duration, t: e.startTime, n: e.name }
    if (e.duration >= 40) add({ k: "event", n: e.name, sid: sid(), pid: DOC, t: r1(e.startTime), d: r1(e.duration), v: r1(e.processingStart - e.startTime) })
  }, { durationThreshold: 16 })
  if (!obs<PerformanceEntry & { blockingDuration: number }>("long-animation-frame", e => add({ k: "loaf", n: "frame", sid: sid(), pid: DOC, t: r1(e.startTime), d: r1(e.duration), v: r1(e.blockingDuration) })))
    obs<PerformanceEntry>("longtask", e => add({ k: "longtask", n: "task", sid: sid(), pid: DOC, t: r1(e.startTime), d: r1(e.duration) }))
  const done = { lcp: false, cls: false, inp: false }
  const fetches = () => {
    for (const f of T.fetches) {
      if (f.t1 == null || f.sent) continue
      f.sent = true
      let u: URL
      try { u = new URL(f.url, location.href) } catch { continue }
      add({ k: "fetch", n: "fetch", sid: f.spanId, pid: f.parent || DOC, t: r1(f.t0), d: r1(f.t1 - f.t0), tg: u.origin === location.origin ? u.pathname : "external", st: f.status, r: f.ray || undefined })
    }
  }
  const vitals = (final: boolean) => {
    const l = lcp as (PerformanceEntry & { element?: Element | null }) | null
    if (l && !done.lcp && final) { done.lcp = true; add({ k: "lcp", n: "lcp", sid: sid(), pid: DOC, t: r1(l.startTime), v: r1(l.startTime), dt: (l.element?.tagName || "").toLowerCase().slice(0, 16) || undefined }) }
    if (final && !done.cls) { done.cls = true; add({ k: "cls", n: "cls", sid: sid(), pid: DOC, t: r1(performance.now()), v: Math.round(cls * 10000) / 10000 }) }
    let worst: { d: number; t: number; n: string } | null = null
    for (const k in inter) { const x = inter[k]!; if (!worst || x.d > worst.d) worst = x }
    if (final && worst && !done.inp) { done.inp = true; add({ k: "inp", n: worst.n, sid: sid(), pid: DOC, t: r1(worst.t), d: r1(worst.d), v: r1(worst.d) }) }
  }
  const flush = (final: boolean) => {
    fetches(); vitals(final)
    while (buf.length) {
      const body = JSON.stringify({ tp, page: location.pathname, seq: seq++, to: performance.timeOrigin, vw: innerWidth, dpr: devicePixelRatio, wd: navigator.webdriver === true || SYN, s: buf.splice(0, 250) })
      try { if (final && navigator.sendBeacon && navigator.sendBeacon("/rum", new Blob([body], { type: "application/json" }))) continue } catch { /* fall back to fetch */ }
      try { fetch("/rum", { method: "POST", body, keepalive: body.length < 60000, headers: { "content-type": "application/json" } }).catch(noop) } catch { /* best effort */ }
    }
  }
  addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(true) })
  addEventListener("pagehide", () => flush(true))
  setInterval(() => flush(false), 15000)
  const app = (k: string) => (name: string, t0: number, t1: number | null, detail?: string) => add({ k, n: name, sid: sid(), pid: DOC, t: r1(t0), d: t1 == null ? undefined : r1(t1 - t0), dt: detail })
  const span = app("app"), interaction = app("interaction")
  const rum: Rum = { off: null, span, interaction, mark: (name, detail) => { span(name, performance.now(), null, detail); if (name === "data-ready") setTimeout(() => flush(false), 2000) }, flush }
  window.__rum = rum
  span("boot", 0, performance.now())
  return rum
}
