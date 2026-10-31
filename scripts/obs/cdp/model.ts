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
  /** where `end` and the phases come from (shown in the viewer's detail panel) */
  endFrom?: string | undefined; phFrom?: Record<string, string> | undefined
  /** documents (CDP): every Network.dataReceived [ms, decoded bytes]; the embedded answers' UTF-8 byte ranges in the body */
  chunks?: Array<[number, number]> | undefined; embeds?: Array<{ id: string; start: number; end: number }> | undefined; bodyBytes?: number | null | undefined
}
export type MainEv = [start: number, dur: number, depth: number, name: string, detail: string]
export interface Mark { t: number; name: string; kind: string; latency?: number | null; src?: string }
export interface Client {
  source: "cdp" | "rum"; origin: string; t0Wall: number; traceId: string; reqs: CReq[]; main: MainEv[]; marks: Mark[]
  fcp: number | null; lcp: number | null; data: number | null; inp: number | null; cls: number | null
  byCat: Record<string, number>; byCatToData: Record<string, number>
  /** unthrottled clock probes (journey.ts: Node fetches of /healthz around the run): offset bounds only, not requests */
  calib?: Array<{ ray: string; sendWall: number; headWall: number }>
  /** the boot's own mark of where the first answers came from (CDP: ephem:embedded / ephem:fetched); null when not recorded */
  dataSource?: { t: number; kind: "embedded" | "fetched" } | null
}

const TASK = new Set(["RunTask", "LoAF", "longtask"])
/** When the embedded answers' last byte reached the browser: the first Network.dataReceived at which the cumulative decoded
 *  bytes cover the last embed's end offset. Only when the chunks add up to the body's length (else the mapping is unknown). */
function embedArrival(r: CReq) {
  if (!r.chunks?.length || !r.embeds?.length || r.bodyBytes == null) return null
  const total = r.chunks.reduce((a, c) => a + c[1], 0), need = Math.max(...r.embeds.map(e => e.end))
  if (total !== r.bodyBytes) return { t: null, need, total, body: r.bodyBytes, note: `chunk bytes ${total} ≠ body ${r.bodyBytes}: not mapped` }
  let cum = 0
  for (const [t, n] of r.chunks) { cum += n; if (cum >= need) return { t, need, total, body: r.bodyBytes, ids: r.embeds.map(e => e.id), note: "" } }
  return null
}
export function buildModel(c: Client, srvIn: Server, meta: Record<string, unknown>) {
  const { invs, spans: sspans, ingestS } = srvIn

  // ---------- clock offset (NTP-style bounds, intersected) ----------
  // server = client + θ. The Worker's root span starts after the browser sent (t2 > t1 + θ) and its first byte leaves before
  // the browser has the headers (t3 < t4 + θ): θ ∈ (t3 − t4, t2 − t1). Server times are whole ms: widen by 1 ms each side.
  // t3: the response leaving. The runtime's time_to_first_byte_ms can exceed the client's whole send → headers (a streamed
  // body: headers leave first; seen on /v1/track, 68 ms vs 52.7 ms), so t3 is the earlier of it and the Effect request span's end.
  const bounds: Array<{ ray: string; lo: number; hi: number; path: string }> = []
  const bound = (ray: string, sendWall: number, headWall: number, path: string) => {
    const root = sspans.find(s => s.ray && ray0(s.ray) === ray0(ray) && s.ep === "default" && !s.parent)
    if (!root) return
    const eff = sspans.find(s => s.trace === root.trace && s.a["effect.span_id"] && !s.a["effect.parent_id"] && /^(GET|POST|HEAD)$/.test(s.name))
    const ttfb = Math.min(root.a["cloudflare.response.time_to_first_byte_ms"] ?? 0, eff ? eff.e - root.s : Infinity)
    bounds.push({ ray, lo: root.s + Math.max(0, ttfb) - headWall - 1, hi: root.s - sendWall + 1, path })
  }
  for (const r of c.reqs) if (r.ray && r.sendWall != null && r.headWall != null && !r.fromCache) bound(r.ray, r.sendWall, r.headWall, new URL(r.url).pathname)
  for (const p of c.calib ?? []) bound(p.ray, p.sendWall, p.headWall, "/healthz (clock probe)")
  // Marzullo: the interval covered by the most bounds (all of them when they agree); a bound that disagrees is reported.
  const edges = bounds.flatMap(b => [{ x: b.lo, d: 1 }, { x: b.hi, d: -1 }]).toSorted((a, z) => a.x - z.x || z.d - a.d)
  let cnt = 0, bestN = 0, lo = 0, hi = 0
  for (let i = 0; i < edges.length; i++) { cnt += edges[i]!.d; if (cnt > bestN && edges[i + 1]) { bestN = cnt; lo = edges[i]!.x; hi = edges[i + 1]!.x } }
  const consistent = bounds.length > 0 && bestN === bounds.length
  const outliers = bounds.filter(b => b.hi < lo || b.lo > hi).map(b => ({ path: b.path, ray: b.ray, lo: +b.lo.toFixed(1), hi: +b.hi.toFixed(1) }))
  const best = bounds.toSorted((a, b) => (a.hi - a.lo) - (b.hi - b.lo))[0]
  const theta = (lo + hi) / 2
  const offset = { thetaMs: +theta.toFixed(2), plusMinusMs: +((hi - lo) / 2).toFixed(2), lo: +lo.toFixed(2), hi: +hi.toFixed(2), n: bounds.length, agree: bestN, consistent, outliers,
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
    return { i, url: u.pathname + (u.pathname.startsWith("/") && u.search ? `?${[...u.searchParams.keys()].join("&")}` : ""), path: u.pathname, method: r.method, type: r.type, status: r.status,
      protocol: r.protocol ?? null, start: r.start, end: r.end, bytes: r.bytes, ph: r.ph, ray: r.ray ?? null, cache: r.cache ?? null, fromCache: r.fromCache ?? null,
      version: r.version ?? null, serverTiming: r.serverTiming ?? null, traceId: r.traceId ?? null, spanId: r.spanId ?? null, byTrace, join, reason,
      endFrom: r.end != null ? r.endFrom ?? "client" : null, phFrom: r.phFrom ?? null, chunks: r.chunks ?? null, embedAt: embedArrival(r),
      front: inv ? { cpu: inv.cpu, wall: inv.wall, outcome: inv.outcome, status: inv.status, colo: inv.colo, version: inv.version.slice(0, 8), trace: inv.trace, from: inv.from ?? "invocation event" } : null,
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
      front: { cpu: v.cpu, wall: v.wall, outcome: v.outcome, status: v.status, colo: v.colo, version: v.version.slice(0, 8), trace: v.trace, from: v.from ?? "invocation event" } })
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
      s: srvRel(s.s), e: srvRel(s.e), endFrom: s.endFrom ?? "endTime or durationMS (raw saved before the source was kept)", ttfb, respEnd: null as number | null, bodyEnd: null as number | null, bodyEndFrom: null as string | null, bodyNote: null as string | null,
      alive: null as null | { by: string[]; last: string | null; lastEnd: number | null; note: string }, label, cache, a: s.a }
    // first byte: root span start + the runtime's cloudflare.response.time_to_first_byte_ms (derived: start + a recorded duration)
    if (isRoot && s.ep === "default" && ttfb != null) x.respEnd = +(x.s + ttfb).toFixed(3)
    // A streamed document's body keeps leaving after the first byte (src/embed.ts streamHtml). Its end is the html.stream span's
    // end (since 7f4c1be: the body stream handed its last chunk to the runtime). Without that span the end is not recorded and
    // nothing is drawn for it (before: capped at the invocation's end, which is the waitUntil Basin send: a fabricated 773 ms).
    const rq = reqModel[reqByRay.get(r0) ?? -1]
    if (x.respEnd != null && rq?.type === "Document") {
      const st = sspans.find(y => y.trace === s.trace && y.name === "html.stream")
      if (st && st.endFrom !== "none") Object.assign(x, { bodyEnd: srvRel(st.e), bodyEndFrom: "html.stream span end (the body stream handed its last chunk to the runtime; Workers clock: the last I/O before it)" })
      else x.bodyNote = "end not recorded: no html.stream span in this trace (versions before 7f4c1be don't emit it)"
    }
    // What kept the invocation alive after the response: its waitUntil spans (the Basin sends, src/requestlog.ts) and which
    // span ended last. The root span's end is the invocation's end, not the response's.
    if (isRoot && s.ep === "default") {
      const mine = sspans.filter(y => y.trace === s.trace && y !== s && y.name !== "jsRpcSession")
      const wu = mine.filter(y => y.name === "jsRpcCall"), last = mine.toSorted((a, z) => z.e - a.e)[0]
      x.alive = { by: wu.map(y => `Basin send (jsRpcCall ${y.a["jsrpc.method"] ?? "?"}) ${y.s === s.s ? "from the start" : "+" + (y.s - s.s) + " ms"} → +${y.e - s.s} ms`),
        last: last ? (last.name === "jsRpcCall" ? `Basin send (jsRpcCall ${last.a["jsrpc.method"] ?? "?"}, waitUntil)` : last.name) : null, lastEnd: last ? srvRel(last.e) : null,
        note: last && Math.abs(last.e - s.e) <= 1 ? "the invocation ended when this span did" : "no span ends with the invocation (within 1 ms)" }
    }
    return x
  })

  // ---------- KPIs ----------
  const tasks = c.main.filter(m => TASK.has(m[3]) && m[2] === 0), longTasks = tasks.filter(m => m[1] >= 50)
  const docR = reqModel.find(r => r.type === "Document")
  const cacheCounts: Record<string, number> = {}; for (const r of reqModel) if (r.cache) cacheCounts[r.cache] = (cacheCounts[r.cache] ?? 0) + 1
  const blockCache: Record<string, number> = {}
  for (const x of srv) if (x.name === "blocks.load" || x.name === "geoid.load") for (const part of String(x.cache ?? "").split(",")) { const [kk, n] = part.split(":"); if (kk) blockCache[kk] = (blockCache[kk] ?? 0) + Number(n ?? 1) }
  const fonts = reqModel.filter(r => r.type === "Font" || r.type === "font" || r.path.endsWith(".woff2"))
  const kpiSrc = c.source === "rum"
    ? { ttfb: "Navigation Timing: startTime + (responseStart − startTime)", fcp: "Paint Timing first-contentful-paint (RUM row)", data: "RUM app mark data-ready", serverCpu: "sum of the invocations' cpuTimeMs (Workers Observability)" }
    : { ttfb: "CDP ResourceTiming receiveHeadersEnd of the document (includes DevTools' emulated latency when throttled)", fcp: "CDP trace firstContentfulPaint", data: "CDP trace user timing ephem:data", serverCpu: "sum of the invocations' cpuTimeMs (Workers Observability)" }
  const kpi = {
    ttfb: docR?.ph.wait ? +docR.ph.wait[1].toFixed(1) : null, fcp: c.fcp, lcp: c.lcp, data: c.data, inp: c.inp, cls: c.cls,
    requests: reqModel.length, joined: reqModel.filter(r => r.join === "joined").length,
    serverCpu: invs.reduce((a, v) => a + v.cpu, 0), invocations: invs.length, cache: cacheCounts, blocks: blockCache,
    longTasks: longTasks.length, longestTask: tasks.length ? Math.max(...tasks.map(t => t[1])) : 0,
    fontsDone: fonts.length && fonts.every(f => f.end != null) ? Math.max(...fonts.map(f => f.end!)) : null, mainBusyToData: c.byCatToData, mainBusy: c.byCat,
  }

  // ---------- critical path to "data drawn": recorded links only ----------
  // Not a walk over "ended before" (a heuristic): every link is a recorded event. Today one chain is recorded end to end, the
  // embed: document request → its first byte → the chunk that completed the embedded answers (Network.dataReceived + their
  // byte offsets) → the boot's own ephem:embedded mark → data drawn (ephem:data), each in the main-thread task containing it.
  // When the boot fetched (ephem:fetched), or the run lacks those marks (RUM; runs before this), there is no path: `none` says why.
  type Link = { what: string; t: number | null; src: string }
  const crit = { main: [] as number[], req: [] as number[], srv: [] as number[], links: [] as Link[], none: null as string | null, until: null as number | null }
  const taskAt = (t: number) => tasks.find(x => x[0] <= t + 0.01 && x[0] + x[1] >= t - 0.01)
  if (c.data == null) crit.none = "no data-drawn mark was recorded"
  else if (!c.dataSource) crit.none = c.source === "rum" ? "RUM does not record where the first answers came from (embed or fetch), so no dependency is recorded" : "this run's trace has no ephem:embedded / ephem:fetched mark (journey.ts records it since this change), so no dependency is recorded"
  else if (c.dataSource.kind === "fetched") crit.none = "the boot fetched at least one answer (ephem:fetched); which response fed data drawn is not recorded"
  else if (!docR || !docR.ph.wait) crit.none = "the document request has no recorded timing"
  else {
    const ea = docR.embedAt, ds = c.dataSource
    crit.links.push({ what: "document request starts", t: docR.start, src: "CDP Network.requestWillBeSent" },
      { what: "document first byte", t: docR.ph.wait[1], src: "CDP ResourceTiming receiveHeadersEnd (includes the emulated latency when throttled)" },
      ea && ea.t != null ? { what: `embedded answers complete in the body (bytes ≤ ${ea.need} of ${ea.body})`, t: ea.t, src: "CDP Network.dataReceived: first chunk whose cumulative decoded bytes reach the last embed's end (offsets from the document body)" }
        : { what: "embedded answers complete in the body", t: null, src: ea ? ea.note : "not recorded (no Network.dataReceived chunks or embed offsets in this run)" },
      { what: "boot read the embed (ephem:embedded)", t: ds.t, src: "CDP trace: user timing mark ephem:embedded" },
      { what: "data drawn (ephem:data)", t: c.data, src: "CDP trace: user timing mark ephem:data" })
    if (ea?.t != null && ea.t > ds.t + 0.5) crit.none = `recorded events disagree: the embed's last byte arrived at ${ea.t.toFixed(1)} ms, after the boot read it at ${ds.t.toFixed(1)} ms`
    else {
      crit.req.push(docR.i); crit.until = ea?.t ?? null
      for (const t of [ds.t, c.data]) { const tk = taskAt(t); if (tk && !crit.main.includes(c.main.indexOf(tk))) crit.main.push(c.main.indexOf(tk)) }
      // server: the front door, the embed (home.embed and every Effect span under it, by effect.parent_id) and html.stream
      const mine = srv.filter(x => x.req === docR.i), byEff = new Map(mine.filter(x => x.a["effect.span_id"]).map(x => [x.a["effect.span_id"], x]))
      const underEmbed = (x: typeof mine[number]) => { for (let y: typeof x | undefined = x, g = 0; y && g < 30; y = byEff.get(y.a["effect.parent_id"]), g++) if (y.name === "home.embed") return true; return false }
      for (const x of mine) if ((x.root && x.ep === "default") || x.name === "html.stream" || (x.a["effect.span_id"] && underEmbed(x))) crit.srv.push(x.k)
    }
  }

  // ---------- top client-side costs ----------
  const costs: Array<{ what: string; ms: number; detail: string }> = []
  const fontEnds = fonts.filter(f => f.end != null).map(f => f.end!)   // a font without a recorded end is not counted as done
  if (fontEnds.length && docR?.ph.wait) { const last = Math.max(...fontEnds)
    costs.push({ what: "font loading", ms: +(last - docR.ph.wait[1]).toFixed(1), detail: `derived: last font's end − the document's first byte; ${fonts.length} fonts, ${(fonts.reduce((a, f) => a + f.bytes, 0) / 1024).toFixed(0)} KiB, last one done at ${last.toFixed(0)} ms` }) }
  for (const [cat, ms] of Object.entries(c.byCatToData)) if (cat !== "other" && cat !== "task" && cat !== "net") costs.push({ what: `main thread: ${cat}`, ms: +ms.toFixed(1), detail: `derived: CDP self time (event minus children) before data drawn; ${(c.byCat[cat] ?? 0).toFixed(0)} ms over the whole view` })
  if (longTasks.length) { const top = longTasks.toSorted((a, b) => b[1] - a[1])[0]!
    costs.push({ what: "long tasks (≥ 50 ms)", ms: +longTasks.reduce((a, t) => a + t[1], 0).toFixed(1), detail: `derived: sum of their durations; ${longTasks.length} tasks, longest ${top[1].toFixed(0)} ms at ${top[0].toFixed(0)} ms` }) }
  // a browser-cache hit has no network wait: CDP's phases on a memory-cache hit are the original request's (stale)
  for (const r of crit.req.map(i => reqModel[i]!).filter(r => r.type !== "Document" && !r.fromCache)) if (r.ph.wait)
    costs.push({ what: `network wait on the critical path: ${r.path}`, ms: +(r.ph.wait[1] - r.ph.wait[0]).toFixed(1), detail: `derived: first byte − send; server cpu ${r.front?.cpu ?? "?"} ms, wall ${r.front?.wall ?? "?"} ms incl. waitUntil` })
  costs.sort((a, b) => b.ms - a.ms)   // oxlint-disable-line unicorn/no-array-sort

  const versions = [...new Set(invs.map(v => v.version.slice(0, 8)).filter(Boolean))]
  const inside = reqModel.filter(r => r.front && r.ph.wait).map(r => { const root = srv.find(x => x.req === r.i && x.root && x.ep === "default"); return root && root.respEnd != null ? root.s >= (r.ph.send ?? r.ph.wait!)[0] - offset.plusMinusMs - 0.5 && root.respEnd <= r.ph.wait![1] + offset.plusMinusMs + 0.5 : null }).filter(x => x !== null)
  return {
    meta: { ...meta, source: c.source, versions, traceId: c.traceId, ingestS: +ingestS.toFixed(0) },
    kpi, kpiSrc, offset, costs: costs.slice(0, 8), marks: c.marks, main: c.main, reqs: reqModel, srv, crit,
    inside: { ok: inside.filter(Boolean).length, n: inside.length },
    coverage: { total: reqModel.filter(r => r.join !== "external").length, joined: kpi.joined, byTrace: reqModel.filter(r => r.byTrace).length,
      fetches: reqModel.filter(r => r.spanId && r.type !== "Document").length, fetchesSameTrace: reqModel.filter(r => r.spanId && r.type !== "Document" && r.traceId === c.traceId).length,
      unjoined: reqModel.filter(r => r.join !== "joined").map(r => ({ i: r.i, url: r.url, join: r.join, reason: r.reason })) },
  }
}
export type Model = ReturnType<typeof buildModel>

/** Perfetto / Chrome Trace Event JSON: the model's tracks as synthetic processes (µs from navigation start), plus `extra` events.
 *  Same rule as the viewer: every slice's edges are recorded events (args.src says which); a span without a recorded end is a
 *  "B" with no "E" (Perfetto: did not end); derived instants (first byte = start + ttfb) say so; nothing is capped or inferred. */
export function perfetto(m: Model, extra: any[] = [], usOf: (msRel: number) => number = x => Math.round(x * 1000)) {
  const PID = { net: 90001, edge: 90002, internal: 90003, r2: 90004, waituntil: 90005, input: 90006, main: 90007, crit: 90008 } as const
  const ev: any[] = []
  const meta = (pid: number, n: string, sort: number) => ev.push({ ph: "M", pid, tid: 0, name: "process_name", args: { name: n } }, { ph: "M", pid, tid: 0, name: "process_sort_index", args: { sort_index: sort } })
  meta(PID.input, "Interactions & marks", -10); meta(PID.net, "Network (client timing)", 10); meta(PID.edge, "Cloudflare edge: front door", 11)
  meta(PID.internal, "Internal entrypoints (Api, BlockStore, MetarFeed)", 12); meta(PID.r2, "R2 / blocks / feed", 13); meta(PID.waituntil, "waitUntil (Basin send)", 14)
  meta(PID.crit, "Critical path to data drawn (recorded links)", -9)
  if (!extra.length) { meta(PID.main, "Browser main thread (RUM: long animation frames)", 0); for (const e of m.main) ev.push({ ph: "X", pid: PID.main, tid: 1, name: e[3], ts: usOf(e[0]), dur: Math.max(1, Math.round(e[1] * 1000)), args: { detail: e[4], src: "RUM long animation frame / longtask / event row" } }) }
  for (const r of m.reqs) {
    ev.push({ ph: "M", pid: PID.net, tid: r.i + 1, name: "thread_name", args: { name: `${r.i} ${r.path}` } })
    for (const [k, [a, z]] of Object.entries(r.ph)) ev.push({ ph: "X", pid: PID.net, tid: r.i + 1, name: k, cat: "net", ts: usOf(a), dur: Math.max(1, Math.round((z - a) * 1000)), args: { url: r.url, ray: r.ray, cache: r.cache, status: r.status, src: r.phFrom?.[k] ?? "client timing" } })
    if (r.end == null) ev.push({ ph: "i", s: "t", pid: PID.net, tid: r.i + 1, name: "end not recorded", ts: usOf(Math.max(r.start, ...Object.values(r.ph).map(p => p[1]))), args: { note: "no loadingFinished / responseEnd for this request" } })
    for (const [t, n] of r.chunks ?? []) ev.push({ ph: "i", s: "t", pid: PID.net, tid: r.i + 1, name: `chunk ${n} B`, cat: "net", ts: usOf(t), args: { src: "CDP Network.dataReceived" } })
  }
  for (const x of m.srv) {
    const pid = PID[x.track as keyof typeof PID] ?? PID.edge, args = { ...x.a, ray: m.reqs[x.req]?.ray, trace: x.trace, src: `start: span startTime; end: ${x.endFrom}; shifted by θ ${m.offset.thetaMs} ± ${m.offset.plusMinusMs} ms` }
    if (x.endFrom === "none") ev.push({ ph: "B", pid, tid: x.req + 1, name: x.label + " (end not recorded)", cat: "server", ts: usOf(x.s), args })
    else ev.push({ ph: "X", pid, tid: x.req + 1, name: x.label, cat: "server", ts: usOf(x.s), dur: Math.max(1, Math.round((x.e - x.s) * 1000)), args })
    if (x.respEnd != null) ev.push({ ph: "i", s: "t", pid, tid: x.req + 1, name: "first byte (derived: start + time_to_first_byte_ms)", ts: usOf(x.respEnd), cat: "server" })
    if (x.bodyEnd != null) ev.push({ ph: "i", s: "t", pid, tid: x.req + 1, name: "body end (html.stream end)", ts: usOf(x.bodyEnd), cat: "server", args: { src: x.bodyEndFrom } })
    if (x.bodyNote) ev.push({ ph: "i", s: "t", pid, tid: x.req + 1, name: "body end not recorded", ts: usOf(x.respEnd ?? x.s), cat: "server", args: { note: x.bodyNote } })
    if (x.alive) ev.push({ ph: "i", s: "t", pid, tid: x.req + 1, name: `invocation end: ${x.alive.last ?? "?"}`, ts: usOf(x.e), cat: "server", args: { keptAliveBy: x.alive.by.join("; "), note: x.alive.note } })
  }
  for (const mk of m.marks) ev.push({ ph: "i", s: "g", pid: PID.input, tid: 0, name: mk.name, ts: usOf(mk.t), cat: "mark", args: { src: mk.src ?? "client" } })
  if (m.crit.none) ev.push({ ph: "i", s: "p", pid: PID.crit, tid: 0, name: "no critical path: " + m.crit.none, ts: 0, cat: "crit" })
  for (const l of m.crit.links) if (l.t != null) ev.push({ ph: "i", s: "p", pid: PID.crit, tid: 0, name: l.what, ts: usOf(l.t), cat: "crit", args: { src: l.src } })
  return { traceEvents: [...extra, ...ev], displayTimeUnit: "ms", metadata: { meta: m.meta, offset: m.offset } }
}
