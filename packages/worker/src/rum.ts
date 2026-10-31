// Production RUM: the page's own spans (navigation, every resource with its serverTiming, paints, LCP, CLS, INP, long animation
// frames, every fetch with its traceparent ids, app spans: boot, data-ready, first-sky-draw, key presses, drags), batched by the
// browser (packages/web/src/client/rum.ts) to POST /rum, validated here and written to the Basin stream `ephem_rum` (ops/basin/rum.schema.json; Iceberg
// ephem.rum), one row per span, keyed by trace_id + span_id. ephem.requests has the same trace_id, so SQL joins client spans
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
import { uaFamily } from "./requestlog.ts"
import { ROUTES } from "./routes.ts"
import { parseTraceparent } from "./traceparent.ts"

export interface RumRow {
  ts: string; trace_id: string; span_id: string; parent_id?: string; kind: string; name: string; page: string; target?: string
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

/** A URL path (or "external") → a route id; never the raw path. */
export const targetOf = (p: unknown): string | undefined => {
  if (typeof p !== "string") return undefined
  if (p === "external") return "external"
  if (ROUTES.has(p)) return p
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
    ts: new Date(c.now).toISOString(), trace_id: tp.traceId, page: b.page, seq: Math.round(seq),
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

/** The batch format the page (packages/web/src/client/rum.ts) sends. `window.__rum` = { span(name, t0, t1, detail), mark(name, detail),
 *  interaction(name, t0, t1, detail), flush(), off }. Field names are short (k kind, n name, sid/pid ids, t start, d dur, v value,
 *  tg target path, ph [dns, connect, tls, request, ttfb, download], b bytes, st status, pr protocol, sv serverTiming, r ray, dt detail). */
