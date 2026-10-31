// Server side of a page view from Workers Observability (cf CLI): every invocation and span that served it.
// Selection: front-door invocations by `x-ephem-load: <tag>` (harness runs), every span recording `client.trace_id = <id>` (the
// document, fetches, Api, and BlockStore/MetarFeed `loopback.trace`), and root spans by cf-ray (any request whose ray the client
// knows: CDP response headers, or RUM `ray;desc` Server-Timing). Then internal invocations by ray prefix (Api, BlockStore,
// MetarFeed run as `<front ray>-<colo>`), then every event of every trace found. Polls until complete or `waitS`.
import { execFileSync } from "node:child_process"

type Ev = any
export const ray0 = (r: string | undefined | null) => (r ?? "").split("-")[0]!
const cfq = (filters: any[], from: number, to: number, limit = 1000): Ev[] => {
  const body = {
    queryId: "journey",
    timeframe: { from: Math.floor(from), to: Math.ceil(to) },
    view: "events",
    limit,
    parameters: {
      filters: [{ key: "$metadata.service", operation: "eq", type: "string", value: "ephem" }, ...filters],
    },
  }
  for (let k = 0; ; k++) {
    try {
      return (
        JSON.parse(
          execFileSync("cf", ["o11y", "telemetry", "query", "--body", JSON.stringify(body)], {
            encoding: "utf8",
            maxBuffer: 256 << 20,
          }),
        ).events?.events ?? []
      )
    } catch (e) {
      if (k >= 4) throw e
      execFileSync("sleep", [String(2 ** k)])
    } // 429s under bursts: back off, then fail loudly
  }
}
/** Every event in [from, to): any slice at the 1000-row cap is halved. Dedup by the whole $metadata (never by id: ids collide). */
const cfAll = (filters: any[], from: number, to: number): Ev[] => {
  const out: Ev[] = [],
    seen = new Set<string>(),
    todo: Array<[number, number]> = [[from, to]]
  while (todo.length) {
    const [a, z] = todo.pop()!,
      got = cfq(filters, a, z)
    if (got.length >= 1000 && z - a > 2000) {
      const m = Math.floor((a + z) / 2)
      todo.push([a, m], [m, z])
      continue
    }
    for (const e of got) {
      const k = JSON.stringify(e.$metadata)
      if (!seen.has(k)) {
        seen.add(k)
        out.push(e)
      }
    }
  }
  return out
}
const eq = (key: string, value: string) => ({ key, operation: "eq", type: "string", value })
const inn = (key: string, vs: string[]) => ({ key, operation: "in", type: "string", value: vs.join(",") })
const chunks = <T>(xs: T[], n: number) =>
  Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

const flat = (o: any, p = "", out: Record<string, any> = {}) => {
  for (const [k, v] of Object.entries(o ?? {})) {
    if (v && typeof v === "object" && !Array.isArray(v)) flat(v, p + k + ".", out)
    else out[p + k] = v
  }
  return out
}
// Only these attributes leave this module: never request headers, IPs, the raw query (url.full) or the Api cache key.
const KEEP =
  /^(effect\.(span_id|parent_id|parent)|ephem\.|cache\.|blocks\.|geoid\.|metar\.|asset\.|home\.(source|tz)|client\.|rum\.|http\.route|http\.response\.status_code|http\.status_code|cpu_time_ms|wall_time_ms|cloudflare\.(outcome|colo|response\.time_to_first_byte_ms|entrypoint)|jsrpc\.(method|target_kind)|url\.path|mcp\.|html\.)/
/** endFrom: "endTime" (recorded), "durationMS" (start + recorded duration) or "none" (no end in the event: e = s, drawn open-ended) */
export interface SSpan {
  trace: string
  id: string
  parent?: string
  name: string
  ep: string
  ray?: string
  s: number
  e: number
  endFrom: "endTime" | "durationMS" | "none"
  a: Record<string, any>
}
export interface Inv {
  ray: string
  ray0: string
  trace: string
  ep: string
  cpu: number
  wall: number
  outcome: string
  status?: number
  version: string
  path: string
  colo?: string | undefined
  ts: number
  from?: string
}
export interface Server {
  invs: Inv[]
  spans: SSpan[]
  ingestS: number
}

const toSpan = (x: Ev): SSpan => {
  const src = x.source ?? {},
    a: Record<string, any> = {}
  for (const [k, v] of Object.entries(flat(src)))
    if (KEEP.test(k) && !k.endsWith("api_key") && !k.endsWith("api_server_timing")) a[k] = v
  if (a["url.path"] && String(a["url.path"]).startsWith("/block/")) a["url.path"] = "/block/…"
  return {
    trace: x.$metadata.traceId,
    id: x.$metadata.spanId ?? src.spanId,
    parent: x.$metadata.parentSpanId ?? src.parentSpanId,
    name: src.name,
    ep: src.cloudflare?.entrypoint ?? "default",
    ray: src.cloudflare?.ray_id,
    s: src.startTime,
    e: src.endTime ?? src.startTime + (src.durationMS ?? 0),
    endFrom: src.endTime != null ? "endTime" : src.durationMS != null ? "durationMS" : "none",
    a,
  }
}
const toInv = (e: Ev): Inv => ({
  ray: e.$metadata.rayId,
  ray0: ray0(e.$metadata.rayId),
  trace: e.$metadata.traceId,
  ep: e.$workers?.entrypoint ?? "default",
  cpu: e.$workers?.cpuTimeMs ?? 0,
  wall: e.$workers?.wallTimeMs ?? 0,
  outcome: e.$workers?.outcome,
  status: e.$workers?.event?.response?.status,
  version: e.$workers?.scriptVersion?.id ?? "",
  path: e.$workers?.event?.path ?? new URL(e.$workers?.event?.request?.url ?? "http://x/").pathname,
  colo: undefined,
  ts: e.timestamp,
})

export interface PullOptions {
  from: number
  to: number
  loadTag?: string | undefined
  clientTraceId?: string | undefined
  rays: ReadonlyArray<string> // full cf-rays the client saw (front door)
  needApi?: ReadonlyArray<string> // rays whose Api must have run (client saw a MISS)
  waitS: number
  log: (s: string) => void
}
export async function pullServer(o: PullOptions): Promise<Server> {
  const want = new Set(o.rays.map(ray0)),
    needApi = new Set((o.needApi ?? []).map(ray0)),
    t0 = Date.now()
  let front: Ev[] = [],
    linked: Ev[] = [],
    spans: Ev[] = []
  for (let attempt = 0; ; attempt++) {
    const to = Math.min(Date.now(), o.to)
    front = o.loadTag
      ? cfAll(
          [eq("$metadata.type", "cf-worker-event"), eq("$workers.event.request.headers.x-ephem-load", o.loadTag)],
          o.from,
          to,
        )
      : []
    const byClient = o.clientTraceId
      ? cfAll([eq("$metadata.type", "span"), eq("client.trace_id", o.clientTraceId)], o.from, to)
      : []
    const have = new Set(front.map((e) => ray0(e.$metadata.rayId)))
    const roots: Ev[] = []
    for (const c of chunks(
      o.rays.filter((r) => !have.has(ray0(r))),
      40,
    ))
      roots.push(...cfq([eq("$metadata.type", "span"), inn("cloudflare.ray_id", c)], o.from, to))
    const fr = new Set([...have, ...roots.map((s) => ray0(s.source?.cloudflare?.ray_id))])
    const internal = cfAll(
      [eq("$metadata.type", "cf-worker-event"), inn("$workers.entrypoint", ["Api", "BlockStore", "MetarFeed"])],
      o.from,
      to,
    )
    const clientTraces = new Set(byClient.map((s) => s.$metadata.traceId))
    linked = internal.filter((e) => fr.has(ray0(e.$metadata.rayId)) || clientTraces.has(e.$metadata.traceId))
    const traces = [
      ...new Set([...front, ...linked, ...roots, ...byClient].map((e) => e.$metadata.traceId).filter(Boolean)),
    ] as string[]
    const tev: Ev[] = []
    for (const c of chunks(traces, 15)) tev.push(...cfq([inn("$metadata.traceId", c)], o.from, to))
    const seen = new Set<string>()
    spans = []
    const invTraces = new Set([...front, ...linked].map((e) => e.$metadata.traceId))
    for (const e of tev) {
      const k = JSON.stringify(e.$metadata)
      if (seen.has(k)) continue
      seen.add(k)
      if (e.$metadata?.type === "span") spans.push(e)
      else if (e.$metadata?.type === "cf-worker-event" && !invTraces.has(e.$metadata.traceId)) {
        front.push(e)
        invTraces.add(e.$metadata.traceId)
      }
    }
    const rootSeen = new Set(
      spans.filter((s) => s.source?.cloudflare?.ray_id).map((s) => ray0(s.source.cloudflare.ray_id)),
    )
    const apiSeen = new Set(linked.filter((e) => e.$workers?.entrypoint === "Api").map((e) => ray0(e.$metadata.rayId)))
    const noRoot = [...want].filter((r) => !rootSeen.has(r)),
      noApi = [...needApi].filter((r) => !apiSeen.has(r))
    o.log(
      `ingest poll ${attempt + 1} (+${((Date.now() - t0) / 1000).toFixed(0)} s): ${want.size - noRoot.length}/${want.size} requests' root spans, Api ${needApi.size - noApi.length}/${needApi.size}, ${front.length + linked.length} invocations, ${spans.length} spans`,
    )
    if (!noRoot.length && !noApi.length && (want.size || spans.length)) break
    if (Date.now() - t0 > o.waitS * 1000) {
      o.log(`ingest wait ${o.waitS} s reached; continuing with what arrived (${noRoot.length} rays missing)`)
      break
    }
    await new Promise((r) => setTimeout(r, 10_000))
  }
  const sspans = spans.map(toSpan)
  const invs = [...front, ...linked].map(toInv)
  for (const v of invs)
    v.colo = sspans.find((s) => s.trace === v.trace && s.ray)?.a["cloudflare.colo"] ?? v.ray.split("-")[1]
  // A request whose invocation event never arrived but whose root span did: an invocation-shaped record from the span.
  for (const sp of sspans.filter((s) => s.ray && !s.parent && !invs.some((v) => v.ray === s.ray)))
    invs.push({
      ray: sp.ray!,
      ray0: ray0(sp.ray),
      trace: sp.trace,
      ep: sp.ep,
      cpu: sp.a.cpu_time_ms ?? 0,
      wall: sp.a.wall_time_ms ?? sp.e - sp.s,
      outcome: sp.a["cloudflare.outcome"] ?? "?",
      status: sp.a["http.response.status_code"],
      version: "",
      path: sp.a["url.path"] ?? "",
      colo: sp.a["cloudflare.colo"],
      ts: sp.e,
      from: "root span attributes (the invocation event never arrived)",
    })
  return { invs, spans: sspans, ingestS: (Date.now() - t0) / 1000 }
}
