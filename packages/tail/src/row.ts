// One `ephem_invocations` row per TailItem (schema: packages/worker/ops/basin/invocations.schema.json). Pure, so it is unit-tested.
// Privacy: the path is reduced to a known route (or "other"); no query string, headers, IP or user agent are kept.
import { ROUTES } from "../../worker/src/routes.ts"

/** The parts of a TailItem we read (https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/#tailitems). */
export interface TailItemLike {
  readonly eventTimestamp?: number | null
  readonly outcome?: string
  readonly entrypoint?: string | null
  readonly scriptVersion?: { readonly id?: string } | null
  readonly cpuTime?: unknown
  readonly wallTime?: unknown
  readonly event?: {
    readonly request?: { readonly url?: string; readonly method?: string; readonly headers?: Readonly<Record<string, string>>; readonly cf?: { readonly colo?: unknown } }
    readonly response?: { readonly status?: number }
  } | null
  readonly logs?: ReadonlyArray<{ readonly level?: string; readonly message?: unknown }>
  readonly exceptions?: ReadonlyArray<{ readonly name?: string }>
}

export interface InvocationRow {
  ts: string; script_version?: string; entrypoint?: string; outcome: string; method?: string; route?: string; status?: number
  ray?: string; colo?: string; exception_names?: string; exceptions?: number; error_logs?: number; basin_send_failed?: number
  cpu_ms?: number; wall_ms?: number
}

// The route list is ephem's own (packages/worker/src/routes.ts), so a new route is labelled here the day it ships.
export { ROUTES }
export const routeOf = (url: string | undefined): string | undefined => {
  if (!url) return undefined
  let path: string
  try { path = new URL(url).pathname } catch { return "other" }
  return ROUTES.has(path) ? path : "other"
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined)
const text = (m: unknown) => { try { return typeof m === "string" ? m : JSON.stringify(m) } catch { return "" } }

export const toRow = (t: TailItemLike, now = Date.now()): InvocationRow => {
  const req = t.event?.request, exc = t.exceptions ?? [], logs = t.logs ?? []
  const row: Record<string, unknown> = {
    ts: new Date(num(t.eventTimestamp) ?? now).toISOString(),
    script_version: str(t.scriptVersion?.id), entrypoint: str(t.entrypoint), outcome: str(t.outcome) ?? "unknown",
    method: str(req?.method), route: routeOf(req?.url), status: num(t.event?.response?.status),
    ray: str(req?.headers?.["cf-ray"]), colo: str(req?.cf?.colo),
    exception_names: exc.length ? [...new Set(exc.map(e => e.name ?? "Error"))].join(",") : undefined, exceptions: exc.length,
    error_logs: logs.filter(l => l.level === "error").length,
    basin_send_failed: logs.filter(l => text(l.message).includes("basin_send_failed")).length,
    cpu_ms: num(t.cpuTime), wall_ms: num(t.wallTime),
  }
  for (const k of Object.keys(row)) if (row[k] === undefined) delete row[k]
  return row as unknown as InvocationRow
}

/** ["<entrypoint> <route> <count>", …] for the per-batch `tail_batch` log line. Strings, not an object: Workers Observability
 *  splits object keys on "." (a "/llms.txt" key came back as {"/llms": {"txt": 1}}). A missing entrypoint (the default
 *  handler's TailItem has none) is "-". */
export const routeCounts = (rows: ReadonlyArray<InvocationRow>): string[] => {
  const c = new Map<string, number>()
  for (const r of rows) { const k = `${r.entrypoint ?? "-"} ${r.route ?? "-"}`; c.set(k, (c.get(k) ?? 0) + 1) }
  return [...c].map(([k, n]) => `${k} ${n}`)
}

/** Key names (never values) of a TailItem, logged once per isolate so the doc records what the runtime actually sends. */
export const shapeOf = (t: unknown) => {
  const o = (t ?? {}) as Record<string, unknown>, ev = (o.event ?? {}) as Record<string, unknown>
  const keys = (v: unknown) => (v && typeof v === "object" ? Object.keys(v as object).toSorted() : [])
  return { item: keys(o), event: keys(ev), request: keys(ev.request), response: keys(ev.response), scriptVersion: keys(o.scriptVersion),
    types: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? "array" : v === null ? "null" : typeof v])) }
}
