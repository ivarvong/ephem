// One page view as the viewer's model, from either source: a CDP journey (scripts/obs/journey.ts) or production RUM rows
// (scripts/obs/trace-view.ts). Both hand over a Client (times in ms since navigation start, on the browser's clock) and the
// Server (scripts/obs/cdp/server.ts); this joins them, estimates the clock offset, lays out tracks and finds the critical path.
import { ray0, type Server, type SSpan } from "./server.ts"

export interface CReq {
  url: string; method: string; type: string; status: number; protocol?: string | undefined; fromCache?: string | null | undefined; failed?: string | undefined
  start: number; ph: Record<string, [number, number]>; end: number | null; bytes: number
  ray?: string | undefined; cache?: string | undefined; version?: string | undefined; serverTiming?: string | undefined; traceId?: string | undefined; spanId?: string | undefined
  /** client wall clock (epoch ms) when the request left (sendStart / requestStart) and when its headers arrived: offset bounds */
  sendWall?: number | undefined; headWall?: number | undefined
}
export type MainEv = [start: number, dur: number, depth: number, name: string, detail: string]
export interface Mark { t: number; name: string; kind: string; latency?: number | null }
export interface Client {
  source: "cdp" | "rum"; origin: string; t0Wall: number; traceId: string; reqs: CReq[]; main: MainEv[]; marks: Mark[]
  fcp: number | null; lcp: number | null; data: number | null; inp: number | null; cls: number | null
  byCat: Record<string, number>; byCatToData: Record<string, number>
  /** unthrottled clock probes (journey.ts: Node fetches of /healthz around the run): offset bounds only, not requests */
  calib?: Array<{ ray: string; sendWall: number; headWall: number }>
}

const TASK = new Set(["RunTask", "LoAF", "longtask"])
export function buildModel(c: Client, srvIn: Server, meta: Record<string, unknown>) {
  const { invs, spans: sspans, ingestS } = srvIn

  // ---------- clock offset (NTP-style bounds, intersected) ----------
  // server = client + θ. The Worker's root span starts after the browser sent (t2 > t1 + θ) and its first byte leaves before
  // the browser has the headers (t3 < t4 + θ): θ ∈ (t3 − t4, t2 − t1). Server times are whole ms: widen by 1 ms each side.
  const bounds: Array<{ ray: string; lo: number; hi: number; path: string }> = []
  for (const r of c.reqs) {
    if (!r.ray || r.sendWall == null || r.headWall == null || r.fromCache) continue
    const root = sspans.find(s => s.ray && ray0(s.ray) === ray0(r.ray) && s.ep === "default" && !s.parent)
    if (!root) continue
    const ttfb = root.a["cloudflare.response.time_to_first_byte_ms"] ?? 0
    bounds.push({ ray: r.ray, lo: root.s + ttfb - r.headWall - 1, hi: root.s - r.sendWall + 1, path: new URL(r.url).pathname })
  }
  for (const p of c.calib ?? []) {
    const root = sspans.find(s => s.ray && ray0(s.ray) === ray0(p.ray) && s.ep === "default" && !s.parent)
    if (root) bounds.push({ ray: p.ray, lo: root.s + (root.a["cloudflare.response.time_to_first_byte_ms"] ?? 0) - p.headWall - 1, hi: root.s - p.sendWall + 1, path: "/healthz (clock probe)" })
  }
  let lo = Math.max(...bounds.map(x => x.lo)), hi = Math.min(...bounds.map(x => x.hi))
  const consistent = bounds.length > 0 && lo <= hi
  const best = bounds.toSorted((a, b) => (a.hi - a.lo) - (b.hi - b.lo))[0]
  if (!consistent && best) { lo = best.lo; hi = best.hi }
  if (!bounds.length) { lo = 0; hi = 0 }
  const theta = (lo + hi) / 2
  const offset = { thetaMs: +theta.toFixed(2), plusMinusMs: +((hi - lo) / 2).toFixed(2), lo: +lo.toFixed(2), hi: +hi.toFixed(2), n: bounds.length, consistent,
    tightest: best ? { path: best.path, ray: best.ray, widthMs: +(best.hi - best.lo).toFixed(2) } : null,
    note: "server clock − client clock; each request bounds it by (t3 − t4, t2 − t1); server times are whole ms (±1 ms); the interval is the intersection over all joined requests" }
  const srvRel = (epochMs: number) => +(epochMs - theta - c.t0Wall).toFixed(3)

  // ---------- requests ----------
  const reqModel = c.reqs.filter(r => !r.url.startsWith("data:")).map((r, i) => {
    const u = new URL(r.url), same = u.origin === c.origin
    // A browser-cache hit has the cf-ray of the response that filled the cache (another invocation): never join it.
    const inv = r.ray && !r.fromCache ? invs.find(v => v.ep === "default" && v.ray0 === ray0(r.ray)) : undefined
    const internal = r.ray && !r.fromCache ? invs.filter(v => v.ep !== "default" && v.ray0 === ray0(r.ray)) : []
    let join = "joined", reason = ""
    if (!same) { join = "external"; reason = "not ephem" }
    else if (r.fromCache) { join = "browser-cache"; reason = `browser ${r.fromCache} cache: no request left the browser, no server involved` }
    else if (r.failed && !(r.ray && inv)) { join = "failed"; reason = r.failed }
    else if (!r.ray) { join = "no-ray"; reason = c.source === "rum" ? "no ray in the resource's serverTiming (a response before ray;desc, or no Timing-Allow)" : "no cf-ray on the response" }
    else if (!inv) { join = "missing"; reason = `ray ${r.ray} not in Workers Observability after ${ingestS.toFixed(0)} s` }
    const root = r.ray && !r.fromCache ? sspans.find(s => s.ray && ray0(s.ray) === ray0(r.ray) && !s.parent) : undefined
    const eff = root ? sspans.find(s => s.trace === root.trace && s.a["client.trace_id"]) : undefined
    const byTrace = !!eff && eff.a["client.trace_id"] === c.traceId && (!r.spanId || eff.a["client.span_id"] === r.spanId || eff.a["client.document_span_id"] === r.spanId)
    if (join === "joined") reason = byTrace ? "" : r.spanId || r.type === "Document" ? "joined by cf-ray only (no client.trace_id match)" : ""
    if (join === "joined" && r.failed) reason = (reason ? reason + "; " : "") + `CDP says ${r.failed} (a keepalive fetch: the browser stops reporting it) but the response (${r.status}) and its invocation exist`
    if (inv && r.cache === "HIT" && !internal.some(v => v.ep === "Api")) reason = (reason ? reason + "; " : "") + "Workers Cache HIT: the front door ran, the Api entrypoint did not"
    return { i, url: u.pathname + (u.pathname.startsWith("/v1/") && u.search ? `?${[...u.searchParams.keys()].join("&")}` : ""), path: u.pathname, method: r.method, type: r.type, status: r.status,
      protocol: r.protocol ?? null, start: r.start, end: r.end, bytes: r.bytes, ph: r.ph, ray: r.ray ?? null, cache: r.cache ?? null, fromCache: r.fromCache ?? null,
      version: r.version ?? null, serverTiming: r.serverTiming ?? null, traceId: r.traceId ?? null, spanId: r.spanId ?? null, byTrace, join, reason,
      front: inv ? { cpu: inv.cpu, wall: inv.wall, outcome: inv.outcome, status: inv.status, colo: inv.colo, version: inv.version.slice(0, 8), trace: inv.trace } : null,
      internal: internal.map(v => ({ ep: v.ep, cpu: v.cpu, wall: v.wall, colo: v.colo, path: v.path.startsWith("/block/") ? "/block/…" : v.path, trace: v.trace, status: v.status })) }
  })

  // A beacon sent at pagehide (RUM's sendBeacon) has no response in the browser (ERR_ABORTED: the page is gone), but the
  // server answered it: join each to the next unused front-door invocation of the same path, in order, and say so.
  const used = new Set(reqModel.filter(r => r.front).map(r => ray0(r.ray)))
  for (const r of reqModel.filter(q => (q.join === "failed" || q.join === "no-ray") && q.path === "/rum")) {
    const v = invs.filter(x => x.ep === "default" && x.path === r.path && !used.has(x.ray0)).toSorted((a, z) => a.ts - z.ts)[0]
    if (!v) continue
    used.add(v.ray0)
    Object.assign(r, { ray: v.ray, join: "joined", reason: "beacon at pagehide: the browser stopped tracking it (ERR_ABORTED); joined by path + order to the invocation that stored it",
      front: { cpu: v.cpu, wall: v.wall, outcome: v.outcome, status: v.status, colo: v.colo, version: v.version.slice(0, 8), trace: v.trace } })
  }

  // ---------- server spans → tracks ----------
  const reqByRay = new Map(reqModel.filter(r => r.ray).map(r => [ray0(r.ray!), r.i]))
  const traceRay = new Map<string, string>(); for (const v of invs) traceRay.set(v.trace, v.ray0)
  const track = (s: SSpan) => s.name.startsWith("r2_") || s.name === "blocks.load" || s.name === "geoid.load" || s.name.startsWith("metar.") ? "r2"
    : s.ep !== "default" ? "internal" : s.name === "jsRpcCall" ? "waituntil" : "edge"
  const srv = sspans.filter(s => s.name !== "jsRpcSession" && s.name !== "loopback.trace").filter(s => (traceRay.has(s.trace) && reqByRay.has(traceRay.get(s.trace)!)) || (s.ray && reqByRay.has(ray0(s.ray)))).map((s, k) => {
    const r0 = s.ray ? ray0(s.ray) : traceRay.get(s.trace)!, isRoot = !s.parent && !!s.ray
    const ttfb = isRoot ? s.a["cloudflare.response.time_to_first_byte_ms"] ?? null : null
    const cache = s.a["ephem.api_cache"] ?? s.a["ephem.blocks_cache"] ?? s.a["ephem.geoid_cache"] ?? s.a["ephem.feed_cache"] ?? s.a["metar.tier"] ?? null
    const label = s.name === "jsRpcCall" ? `Basin send (${s.a["jsrpc.method"] ?? "rpc"})` : (isRoot ? `${s.ep === "default" ? "front door" : s.ep} ${s.a["url.path"] ?? ""}` : s.name) + (cache ? ` · ${cache}` : "")
    const x = { k, req: reqByRay.get(r0) ?? -1, trace: s.trace, id: s.id, parent: s.parent ?? null, name: s.name, ep: s.ep, track: isRoot && s.ep !== "default" ? "internal" : track(s), root: isRoot,
      s: srvRel(s.s), e: srvRel(s.e), ttfb, respEnd: null as number | null, label, cache, a: s.a }
    if (isRoot && s.ep === "default" && ttfb != null) x.respEnd = +(x.s + ttfb).toFixed(3)   // after it: waitUntil (the Basin send)
    return x
  })

  // ---------- KPIs ----------
  const tasks = c.main.filter(m => TASK.has(m[3]) && m[2] === 0), longTasks = tasks.filter(m => m[1] >= 50)
  const docR = reqModel.find(r => r.type === "Document")
  const cacheCounts: Record<string, number> = {}; for (const r of reqModel) if (r.cache) cacheCounts[r.cache] = (cacheCounts[r.cache] ?? 0) + 1
  const blockCache: Record<string, number> = {}
  for (const x of srv) if (x.name === "blocks.load" || x.name === "geoid.load") for (const part of String(x.cache ?? "").split(",")) { const [kk, n] = part.split(":"); if (kk) blockCache[kk] = (blockCache[kk] ?? 0) + Number(n ?? 1) }
  const fonts = reqModel.filter(r => r.type === "Font" || r.type === "font" || r.path.endsWith(".woff2"))
  const kpi = {
    ttfb: docR?.ph.wait ? +docR.ph.wait[1].toFixed(1) : null, fcp: c.fcp, lcp: c.lcp, data: c.data, inp: c.inp, cls: c.cls,
    requests: reqModel.length, joined: reqModel.filter(r => r.join === "joined").length,
    serverCpu: invs.reduce((a, v) => a + v.cpu, 0), invocations: invs.length, cache: cacheCounts, blocks: blockCache,
    longTasks: longTasks.length, longestTask: tasks.length ? Math.max(...tasks.map(t => t[1])) : 0,
    fontsDone: fonts.length ? Math.max(...fonts.map(f => f.end ?? 0)) : null, mainBusyToData: c.byCatToData, mainBusy: c.byCat,
  }

  // ---------- critical path to "data drawn" ----------
  // Backward from data-ready: the task it ran in, the request whose response arrived last before that task, the task that sent
  // that request, …, until the document. Heuristic, but every link is a measured end-before-start.
  const crit = { main: [] as number[], req: [] as number[], srv: [] as number[] }
  if (c.data != null) {
    let cursor = c.data
    for (let guard = 0; guard < 12; guard++) {
      const tk = tasks.find(x => x[0] <= cursor + 0.01 && x[0] + x[1] >= cursor - 0.01); if (tk) crit.main.push(c.main.indexOf(tk))
      const before = tk ? tk[0] : cursor
      // Only requests the page can wait on: not the browser's own (favicon, type Other) nor RUM beacons. Before this, a
      // /favicon.ico that ended 0.5 ms after the data fetches was named the top critical-path cost (J20261031T000045Z-y64q).
      const r = reqModel.filter(q => q.end != null && q.end <= before + 0.5 && !crit.req.includes(q.i) && q.join !== "external" && q.type !== "Other" && q.type !== "Ping" && q.path !== "/rum").toSorted((a, b) => b.end! - a.end!)[0]
      if (!r) break
      crit.req.push(r.i)
      for (const x of srv) if (x.req === r.i && x.track !== "waituntil") crit.srv.push(x.k)
      if (r.type === "Document") break
      cursor = r.start
    }
  }

  // ---------- top client-side costs ----------
  const costs: Array<{ what: string; ms: number; detail: string }> = []
  if (fonts.length && docR?.ph.wait) { const last = Math.max(...fonts.map(f => f.end ?? 0))
    costs.push({ what: "font loading", ms: +(last - docR.ph.wait[1]).toFixed(1), detail: `${fonts.length} fonts, ${(fonts.reduce((a, f) => a + f.bytes, 0) / 1024).toFixed(0)} KiB, last one done at ${last.toFixed(0)} ms (cost counted from the document's first byte)` }) }
  for (const [cat, ms] of Object.entries(c.byCatToData)) if (cat !== "other" && cat !== "task" && cat !== "net") costs.push({ what: `main thread: ${cat}`, ms: +ms.toFixed(1), detail: `self time before data drawn (${(c.byCat[cat] ?? 0).toFixed(0)} ms over the whole view)` })
  if (longTasks.length) { const top = longTasks.toSorted((a, b) => b[1] - a[1])[0]!
    costs.push({ what: "long tasks (≥ 50 ms)", ms: +longTasks.reduce((a, t) => a + t[1], 0).toFixed(1), detail: `${longTasks.length} tasks, longest ${top[1].toFixed(0)} ms at ${top[0].toFixed(0)} ms` }) }
  // a browser-cache hit has no network wait: CDP's phases on a memory-cache hit are the original request's (stale)
  for (const r of crit.req.map(i => reqModel[i]!).filter(r => r.type !== "Document" && !r.fromCache)) if (r.ph.wait)
    costs.push({ what: `network wait on the critical path: ${r.path}`, ms: +(r.ph.wait[1] - r.ph.wait[0]).toFixed(1), detail: `send → first byte; server cpu ${r.front?.cpu ?? "?"} ms, wall ${r.front?.wall ?? "?"} ms incl. waitUntil` })
  costs.sort((a, b) => b.ms - a.ms)   // oxlint-disable-line unicorn/no-array-sort

  const versions = [...new Set(invs.map(v => v.version.slice(0, 8)).filter(Boolean))]
  const inside = reqModel.filter(r => r.front && r.ph.wait).map(r => { const root = srv.find(x => x.req === r.i && x.root && x.ep === "default"); return root && root.respEnd != null ? root.s >= (r.ph.send ?? r.ph.wait!)[0] - offset.plusMinusMs - 0.5 && root.respEnd <= r.ph.wait![1] + offset.plusMinusMs + 0.5 : null }).filter(x => x !== null)
  return {
    meta: { ...meta, source: c.source, versions, traceId: c.traceId, ingestS: +ingestS.toFixed(0) },
    kpi, offset, costs: costs.slice(0, 8), marks: c.marks, main: c.main, reqs: reqModel, srv, crit,
    inside: { ok: inside.filter(Boolean).length, n: inside.length },
    coverage: { total: reqModel.filter(r => r.join !== "external").length, joined: kpi.joined, byTrace: reqModel.filter(r => r.byTrace).length,
      fetches: reqModel.filter(r => r.spanId && r.type !== "Document").length, fetchesSameTrace: reqModel.filter(r => r.spanId && r.type !== "Document" && r.traceId === c.traceId).length,
      unjoined: reqModel.filter(r => r.join !== "joined").map(r => ({ i: r.i, url: r.url, join: r.join, reason: r.reason })) },
  }
}
export type Model = ReturnType<typeof buildModel>

/** Perfetto / Chrome Trace Event JSON: the model's tracks as synthetic processes (µs from navigation start), plus `extra` events. */
export function perfetto(m: Model, extra: any[] = [], usOf: (msRel: number) => number = x => Math.round(x * 1000)) {
  const PID = { net: 90001, edge: 90002, internal: 90003, r2: 90004, waituntil: 90005, input: 90006, main: 90007 } as const
  const ev: any[] = []
  const meta = (pid: number, n: string, sort: number) => ev.push({ ph: "M", pid, tid: 0, name: "process_name", args: { name: n } }, { ph: "M", pid, tid: 0, name: "process_sort_index", args: { sort_index: sort } })
  meta(PID.input, "Interactions & marks", -10); meta(PID.net, "Network (client timing)", 10); meta(PID.edge, "Cloudflare edge: front door", 11)
  meta(PID.internal, "Internal entrypoints (Api, BlockStore, MetarFeed)", 12); meta(PID.r2, "R2 / blocks / feed", 13); meta(PID.waituntil, "waitUntil (Basin send)", 14)
  if (!extra.length) { meta(PID.main, "Browser main thread (RUM: long animation frames)", 0); for (const e of m.main) ev.push({ ph: "X", pid: PID.main, tid: 1, name: e[3], ts: usOf(e[0]), dur: Math.max(1, Math.round(e[1] * 1000)), args: { detail: e[4] } }) }
  for (const r of m.reqs) {
    ev.push({ ph: "M", pid: PID.net, tid: r.i + 1, name: "thread_name", args: { name: `${r.i} ${r.path}` } })
    for (const [k, [a, z]] of Object.entries(r.ph)) ev.push({ ph: "X", pid: PID.net, tid: r.i + 1, name: k, cat: "net", ts: usOf(a), dur: Math.max(1, Math.round((z - a) * 1000)), args: { url: r.url, ray: r.ray, cache: r.cache, status: r.status } })
  }
  for (const x of m.srv) ev.push({ ph: "X", pid: PID[x.track as keyof typeof PID] ?? PID.edge, tid: x.req + 1, name: x.label, cat: "server", ts: usOf(x.s), dur: Math.max(1, Math.round((x.e - x.s) * 1000)), args: { ...x.a, ray: m.reqs[x.req]?.ray, trace: x.trace } })
  for (const mk of m.marks) ev.push({ ph: "i", s: "g", pid: PID.input, tid: 0, name: mk.name, ts: usOf(mk.t), cat: "mark" })
  return { traceEvents: [...extra, ...ev], displayTimeUnit: "ms", metadata: { meta: m.meta, offset: m.offset } }
}
