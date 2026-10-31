// Production RUM: the page's own spans (navigation, every resource with its serverTiming, paints, LCP, CLS, INP, long animation
// frames, every fetch with its traceparent ids, app spans: boot, data-ready, first-sky-draw, key presses, drags), batched by the
// browser (RUM_JS) to POST /rum, validated here and written to the Basin stream `ephem_rum` (ops/basin/rum.schema.json; Iceberg
// ephem.rum), one row per span, keyed by trace_id + span_id. ephem.requests_v2 has the same trace_id, so SQL joins client spans
// to server request rows (scripts/obs/trace-view.ts).
// Privacy (hard rule; test/rum.test.ts): no IP, no user agent (family only), no URL or query: targets are route ids (ROUTES,
// `/fonts/<known file>`, "other", "external"), names and details from fixed patterns, ids hex only. DNT or GPC (header or
// navigator) → nothing is sent or stored. The traceparent's sampled flag 00 → nothing. Synthetic traffic (x-ephem-load,
// x-ephem-smoke, navigator.webdriver, a document served with <meta name=ephem-synthetic>) is stored with synthetic = true.
// Limits: body ≤ 64 KiB, ≤ 300 spans per batch, ≤ 30 batches per trace per minute and ≤ 600 batches per 10 s per isolate
// (best effort, in-isolate: a Worker has no cheaper shared counter, and a flood only costs us the rows we drop).
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import type { EphemRumRecord } from "./basin.generated.ts"
import { FONTS } from "./fonts.ts"
import { uaFamily } from "./requestlog.ts"
import { ROUTES } from "./routes.ts"
import { parseTraceparent } from "./traceparent.ts"

export interface RumRow {
  ts: string; schema: 1; trace_id: string; span_id: string; parent_id?: string; kind: string; name: string; page: string; target?: string
  start_ms: number; dur_ms?: number; value?: number; time_origin?: string
  dns_ms?: number; connect_ms?: number; tls_ms?: number; request_ms?: number; ttfb_ms?: number; download_ms?: number
  transfer_bytes?: number; status?: number; protocol?: string; cache?: string; server_timing?: string; ray?: string; detail?: string
  seq: number; version?: string; colo?: string; country?: string; ua_family: string; vw?: number; dpr?: number; synthetic: boolean
}
const _assignable: (r: RumRow) => EphemRumRecord = r => r
void _assignable

export const RUM_LIMITS = { maxBytes: 64 * 1024, maxSpans: 300, perTracePerMin: 30, perIsolatePer10s: 600 } as const
export const KINDS = new Set(["navigation", "resource", "fetch", "paint", "lcp", "cls", "inp", "event", "loaf", "longtask", "app", "interaction"])
const PAGES = new Set(["/"])
const H16 = /^[0-9a-f]{16}$/, NAME = /^[a-z][a-z0-9:._-]{0,39}$/, DETAIL = /^[A-Za-z0-9 _.:-]{0,32}$/, RAY = /^[0-9a-f]{16}(-[A-Z]{3})?$/
const PROTO = /^(h2|h3|http\/1\.1|http\/1\.0)$/, ST = /^[A-Za-z0-9 ;=,."_:/-]{0,400}$/
const ASSET = /^\/fonts\/[0-9a-f]{12}\/([A-Za-z0-9._-]{1,64})$/

/** A URL path (or "external") → a route id; never the raw path. */
export const targetOf = (p: unknown): string | undefined => {
  if (typeof p !== "string") return undefined
  if (p === "external") return "external"
  if (ROUTES.has(p)) return p
  const a = ASSET.exec(p); if (a && FONTS[a[1]!]) return `/fonts/${a[1]}`
  return "other"
}
const num = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v * 1000) / 1000)) : undefined
const HOUR = 3_600_000

export interface RumContext {
  readonly now: number; readonly headers: Readonly<Record<string, string | undefined>>
  readonly cf?: { readonly colo?: unknown; readonly country?: unknown } | undefined; readonly version?: string | undefined
}
export type RumResult = { ok: true; rows: RumRow[]; dropped: number } | { ok: false; status: number; reason: string }

/** Pure: a /rum batch → rows. Anything not matching the patterns is dropped (the span, or the whole batch if its envelope is bad). */
export const validateRum = (body: unknown, c: RumContext): RumResult => {
  if (c.headers["dnt"] === "1" || c.headers["sec-gpc"] === "1") return { ok: true, rows: [], dropped: 0 }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, status: 400, reason: "not an object" }
  const b = body as Record<string, unknown>
  if (b.v !== 1) return { ok: false, status: 400, reason: "v must be 1" }
  const tp = typeof b.tp === "string" ? parseTraceparent(b.tp) : undefined
  if (!tp) return { ok: false, status: 400, reason: "tp must be a valid traceparent" }
  if (!(b.tp as string).endsWith("-01")) return { ok: true, rows: [], dropped: 0 }   // not sampled
  if (typeof b.page !== "string" || !PAGES.has(b.page)) return { ok: false, status: 400, reason: "unknown page" }
  if (!Array.isArray(b.s)) return { ok: false, status: 400, reason: "s must be an array" }
  if (b.s.length > RUM_LIMITS.maxSpans) return { ok: false, status: 413, reason: `at most ${RUM_LIMITS.maxSpans} spans` }
  const seq = num(b.seq, 0, 1e6) ?? 0, to = num(b.to, 0, 1e14)
  const synthetic = !!(c.headers["x-ephem-load"] || c.headers["x-ephem-smoke"] || b.wd === true)
  const str = (v: unknown) => typeof v === "string" && v ? v : undefined
  const base = {
    ts: new Date(c.now).toISOString(), schema: 1 as const, trace_id: tp.traceId, page: b.page, seq: Math.round(seq),
    time_origin: to !== undefined && Math.abs(to - c.now) < 24 * HOUR ? new Date(to).toISOString() : undefined,
    version: c.version, colo: str(c.cf?.colo), country: str(c.cf?.country), ua_family: uaFamily(c.headers["user-agent"], undefined),
    vw: (v => v === undefined ? undefined : Math.round(v))(num(b.vw, 0, 20000)), dpr: num(b.dpr, 0, 10), synthetic,
  }
  const rows: RumRow[] = []; let dropped = 0
  for (const s of b.s as unknown[]) {
    if (!s || typeof s !== "object") { dropped++; continue }
    const x = s as Record<string, unknown>
    const kind = x.k, sid = x.sid, start = num(x.t, -HOUR, HOUR)
    if (typeof kind !== "string" || !KINDS.has(kind) || typeof sid !== "string" || !H16.test(sid) || start === undefined) { dropped++; continue }
    const target = kind === "resource" || kind === "fetch" || kind === "navigation" ? targetOf(x.tg) : undefined
    const name = kind === "resource" || kind === "fetch" ? (typeof x.n === "string" && NAME.test(x.n) ? x.n : kind) : typeof x.n === "string" && NAME.test(x.n) ? x.n : undefined
    if (!name) { dropped++; continue }
    const ph = Array.isArray(x.ph) ? x.ph : []
    const st = typeof x.sv === "string" && ST.test(x.sv) ? x.sv : undefined
    const row: Record<string, unknown> = {
      ...base, span_id: sid, parent_id: typeof x.pid === "string" && H16.test(x.pid) ? x.pid : tp.spanId, kind, name, target,
      start_ms: start, dur_ms: num(x.d, 0, HOUR), value: num(x.v, -1e9, 1e9),
      dns_ms: num(ph[0], 0, HOUR), connect_ms: num(ph[1], 0, HOUR), tls_ms: num(ph[2], 0, HOUR), request_ms: num(ph[3], 0, HOUR), ttfb_ms: num(ph[4], 0, HOUR), download_ms: num(ph[5], 0, HOUR),
      transfer_bytes: (v => v === undefined ? undefined : Math.round(v))(num(x.b, 0, 1e10)), status: (v => v === undefined ? undefined : Math.round(v))(num(x.st, 0, 999)),
      protocol: typeof x.pr === "string" && PROTO.test(x.pr) ? x.pr : undefined,
      server_timing: st, cache: st ? /(?:^|,\s*)api;desc="?([A-Z_]{2,16})/.exec(st)?.[1] : undefined,
      ray: typeof x.r === "string" && RAY.test(x.r) ? x.r : st ? /(?:^|,\s*)ray;desc="?([0-9a-f]{16}(?:-[A-Z]{3})?)/.exec(st)?.[1] : undefined,
      detail: typeof x.dt === "string" && DETAIL.test(x.dt) && x.dt ? x.dt : undefined,
    }
    for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k]
    rows.push(row as unknown as RumRow)
  }
  return { ok: true, rows, dropped }
}

/** In-isolate rate limiter (best effort): per trace per minute, and per isolate per 10 s. */
export const makeLimiter = (lim: { readonly perTracePerMin: number; readonly perIsolatePer10s: number } = RUM_LIMITS) => {
  const perTrace = new Map<string, { n: number; t: number }>(); let win = { n: 0, t: 0 }
  return (trace: string, now: number): boolean => {
    if (now - win.t > 10_000) win = { n: 0, t: now }
    if (++win.n > lim.perIsolatePer10s) return false
    if (perTrace.size > 5000) for (const [k, v] of perTrace) if (now - v.t > 60_000) perTrace.delete(k)
    const e = perTrace.get(trace)
    if (!e || now - e.t > 60_000) { perTrace.set(trace, { n: 1, t: now }); return true }
    return ++e.n <= lim.perTracePerMin
  }
}
const limiter = makeLimiter()

/** Where rows go (the Worker: env.RUM via waitUntil; tests: an array). Absent → validated and dropped. */
export interface RumSinkI { readonly version?: string | undefined; readonly emit: (rows: ReadonlyArray<RumRow>) => void }
export class RumSink extends Context.Service<RumSink, RumSinkI>()("@ephem/worker/RumSink") {}

const noStore = (status: number, extra: Record<string, string> = {}) => HttpServerResponse.empty({ status, headers: { "cache-control": "no-store", ...extra } })
export const Rum = HttpRouter.add("POST", "/rum", Effect.gen(function* () {
  const req = yield* HttpServerRequest.HttpServerRequest
  const headers = req.headers as Readonly<Record<string, string | undefined>>
  const len = Number(headers["content-length"] ?? "0")
  if (len > RUM_LIMITS.maxBytes) return noStore(413)
  const text = yield* Effect.orElseSucceed(req.text, () => "")
  if (text.length > RUM_LIMITS.maxBytes) return noStore(413)
  let body: unknown
  try { body = JSON.parse(text) } catch { return noStore(400) }
  const sink = yield* Effect.serviceOption(RumSink)
  const now = Date.now()
  const r = validateRum(body, { now, headers, cf: (req.source as { cf?: RumContext["cf"] } | undefined)?.cf, version: sink._tag === "Some" ? sink.value.version : undefined })
  if (!r.ok) { yield* Effect.annotateCurrentSpan({ "rum.rejected": r.reason }); return noStore(r.status) }
  if (r.rows.length && !limiter(r.rows[0]!.trace_id, now)) return noStore(429, { "retry-after": "60" })
  // The batch's page view: so its /rum invocation (a pagehide beacon has no response for the browser to see) joins the trace.
  const tp = r.rows[0] ? { "client.trace_id": r.rows[0].trace_id } : {}
  yield* Effect.annotateCurrentSpan({ "rum.rows": r.rows.length, "rum.dropped": r.dropped, ...tp })
  if (sink._tag === "Some" && r.rows.length) sink.value.emit(r.rows)
  return noStore(204, { "x-ephem-rum": `${r.rows.length} ${r.dropped}` })
}))

/** The prod sink: one send per batch from waitUntil; a failed send is one countable error line. */
export const rumPipelineSink = (rum: { send(r: ReadonlyArray<RumRow>): Promise<void> }, waitUntil: (p: Promise<unknown>) => void, version?: string): RumSinkI => ({
  version,
  emit: rows => waitUntil(rum.send(rows).catch((e: unknown) => console.error(JSON.stringify({ basin_send_failed: { stream: "ephem_rum", rows: rows.length, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) } })))),
})

/** Browser side, inlined in both pages after CLIENT_TRACE_JS. `window.__rum` = { span(name, t0, t1, detail), mark(name, detail),
 *  interaction(name, t0, t1, detail), flush(), off }. Field names are short (k kind, n name, sid/pid ids, t start, d dur, v value,
 *  tg target path, ph [dns, connect, tls, request, ttfb, download], b bytes, st status, pr protocol, sv serverTiming, r ray, dt detail). */
export const RUM_JS = String.raw`
(function () {
  var T = window.__ephemTrace, N = navigator, noop = function () {};
  var off = !T ? "no-trace" : (N.doNotTrack === "1" || window.doNotTrack === "1" || N.globalPrivacyControl === true) ? "privacy" : null;
  var tp = null; try { var m = document.querySelector('meta[name="traceparent"]'); tp = m && m.getAttribute("content"); } catch (e) {}
  if (!off && T) { if (!tp || tp.indexOf(T.traceId) < 0) tp = "00-" + T.traceId + "-" + (T.parentSpanId || T.hex(8)) + "-01"; if (!/-01$/.test(tp)) off = "unsampled"; }
  if (off || !window.PerformanceObserver) { window.__rum = { off: off || "unsupported", span: noop, mark: noop, interaction: noop, flush: noop }; return; }
  var SYN = !!document.querySelector('meta[name="ephem-synthetic"]');   // the document request was synthetic (src/clienttrace.ts)
  var buf = [], seq = 0, DOC = T.parentSpanId, r1 = function (x) { return x == null ? undefined : Math.round(x * 10) / 10; };
  function add(o) { if (buf.length < 600) buf.push(o); }
  function sid() { return T.hex(8); }
  function stOf(e) { try { return (e.serverTiming || []).map(function (s) { return s.name + (s.description ? ';desc="' + s.description + '"' : "") + (s.duration ? ";dur=" + s.duration : ""); }).join(", ").slice(0, 400); } catch (er) { return undefined; } }
  function phases(e) {
    var tls = e.secureConnectionStart > 0 ? e.connectEnd - e.secureConnectionStart : 0;
    return [r1(e.domainLookupEnd - e.domainLookupStart), r1((e.secureConnectionStart > 0 ? e.secureConnectionStart : e.connectEnd) - e.connectStart), r1(tls),
      e.responseStart > 0 ? r1(e.responseStart - e.requestStart) : undefined, e.responseStart > 0 ? r1(e.responseStart - e.startTime) : undefined, e.responseStart > 0 ? r1(e.responseEnd - e.responseStart) : undefined];
  }
  function fetchFor(u, t) { var f = T.fetches; for (var i = 0; i < f.length; i++) if (!f[i].used && f[i].url && new URL(f[i].url, location.href).href === u && Math.abs(f[i].t0 - t) < 50) { f[i].used = 1; return f[i]; } return null; }
  function resource(e) {
    var u; try { u = new URL(e.name, location.href); } catch (er) { return; }
    if (u.origin === location.origin && u.pathname === "/rum") return;
    var f = e.initiatorType === "fetch" ? fetchFor(u.href, e.startTime) : null;
    add({ k: "resource", n: e.initiatorType || "other", sid: f ? f.spanId : sid(), pid: DOC, t: r1(e.startTime), d: r1(e.duration), tg: u.origin === location.origin ? u.pathname : "external",
      ph: phases(e), b: e.transferSize, st: e.responseStatus, pr: e.nextHopProtocol, sv: stOf(e), r: f ? f.ray : undefined });
  }
  function obs(type, fn, opts) { try { var o = new PerformanceObserver(function (l) { l.getEntries().forEach(fn); }); o.observe(Object.assign({ type: type, buffered: true }, opts || {})); return o; } catch (e) { return null; } }
  var nav = performance.getEntriesByType("navigation")[0];
  if (nav) add({ k: "navigation", n: (nav.type || "navigate").replace(/_/g, "-"), sid: DOC || sid(), pid: undefined, t: 0, d: r1(nav.duration || nav.loadEventEnd), tg: location.pathname,
    ph: phases(nav), b: nav.transferSize, st: nav.responseStatus, pr: nav.nextHopProtocol, sv: stOf(nav), v: r1(nav.domContentLoadedEventEnd) });
  obs("resource", resource);
  obs("paint", function (e) { add({ k: "paint", n: e.name === "first-contentful-paint" ? "fcp" : "fp", sid: sid(), pid: DOC, t: r1(e.startTime) }); });
  var lcp = null; obs("largest-contentful-paint", function (e) { lcp = e; });
  var cls = 0, sess = 0, last = 0, first = 0; obs("layout-shift", function (e) { if (e.hadRecentInput) return; if (e.startTime - last > 1000 || e.startTime - first > 5000) { sess = 0; first = e.startTime; } sess += e.value; last = e.startTime; if (sess > cls) cls = sess; });
  var inter = {}; obs("event", function (e) { if (!e.interactionId) return; var p = inter[e.interactionId]; if (!p || e.duration > p.d) inter[e.interactionId] = { d: e.duration, t: e.startTime, n: e.name }; if (e.duration >= 40) add({ k: "event", n: e.name, sid: sid(), pid: DOC, t: r1(e.startTime), d: r1(e.duration), v: r1(e.processingStart - e.startTime) }); }, { durationThreshold: 16 });
  if (!obs("long-animation-frame", function (e) { add({ k: "loaf", n: "frame", sid: sid(), pid: DOC, t: r1(e.startTime), d: r1(e.duration), v: r1(e.blockingDuration) }); })) obs("longtask", function (e) { add({ k: "longtask", n: "task", sid: sid(), pid: DOC, t: r1(e.startTime), d: r1(e.duration) }); });
  var done = {};
  function fetches() { T.fetches.forEach(function (f) { if (f.t1 == null || f.sent) return; f.sent = 1; var u; try { u = new URL(f.url, location.href); } catch (e) { return; }
    add({ k: "fetch", n: "fetch", sid: f.spanId, pid: f.parent || DOC, t: r1(f.t0), d: r1(f.t1 - f.t0), tg: u.origin === location.origin ? u.pathname : "external", st: f.status, r: f.ray || undefined }); }); }
  function vitals(final) {
    if (lcp && !done.lcp && final) { done.lcp = 1; add({ k: "lcp", n: "lcp", sid: sid(), pid: DOC, t: r1(lcp.startTime), v: r1(lcp.startTime), dt: (lcp.element && lcp.element.tagName || "").toLowerCase().slice(0, 16) || undefined }); }
    if (final && !done.cls) { done.cls = 1; add({ k: "cls", n: "cls", sid: sid(), pid: DOC, t: r1(performance.now()), v: Math.round(cls * 10000) / 10000 }); }
    var worst = null; for (var k in inter) if (!worst || inter[k].d > worst.d) worst = inter[k];
    if (final && worst && !done.inp) { done.inp = 1; add({ k: "inp", n: worst.n, sid: sid(), pid: DOC, t: r1(worst.t), d: r1(worst.d), v: r1(worst.d) }); }
  }
  function flush(final) {
    fetches(); vitals(final);
    while (buf.length) {
      var body = JSON.stringify({ v: 1, tp: tp, page: location.pathname, seq: seq++, to: performance.timeOrigin, vw: innerWidth, dpr: devicePixelRatio, wd: N.webdriver === true || SYN, s: buf.splice(0, 250) });
      try { if (final && N.sendBeacon && N.sendBeacon("/rum", new Blob([body], { type: "application/json" }))) continue; } catch (e) {}
      try { fetch("/rum", { method: "POST", body: body, keepalive: body.length < 60000, headers: { "content-type": "application/json" } }).catch(noop); } catch (e) {}
    }
  }
  addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flush(true); });
  addEventListener("pagehide", function () { flush(true); });
  setInterval(function () { flush(false); }, 15000);
  function app(k) { return function (name, t0, t1, detail) { add({ k: k, n: name, sid: sid(), pid: DOC, t: r1(t0), d: t1 == null ? undefined : r1(t1 - t0), dt: detail }); }; }
  var span = app("app"), interaction = app("interaction");
  window.__rum = { off: null, span: span, interaction: interaction, mark: function (name, detail) { span(name, performance.now(), null, detail); if (name === "data-ready") setTimeout(function () { flush(false); }, 2000); }, flush: flush };
  span("boot", 0, performance.now());
})();
`
