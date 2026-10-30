// Unified client + server trace of one page journey on ephem, driven by our own CDP client (scripts/obs/cdp/).
//   node --experimental-strip-types scripts/obs/journey.ts <url> [--device iphone|desktop] [--net fast3g|4g|none] [--cpu 4]
//        [--cold|--warm] [--script instrument-sky|home-drag|none] [--duration 70] [--out dir] [--name base] [--headed]
//        [--at lat,lon] [--wait 240]
// Chrome side: Tracing (devtools.timeline: parse, script, style/layout, paint, long tasks) + every Network request with full
// timing and headers. The document carries the harness's traceparent (adopted by the Worker; the page reuses it from <meta
// name=traceparent>), so the document and every fetch share one trace id. Server side (cdp/server.ts): every request the page
// made (document, fonts, every fetch and poll, the RUM beacons) joined to its front-door invocation, its Api / BlockStore /
// MetarFeed loopbacks and every span (R2, cache status, the Basin send in waitUntil). Then the page's own production RUM rows
// (Basin ephem.rum, same trace id) are checked against CDP's ground truth: the RUM's test. Clock offset: cdp/model.ts.
// Writes <name>.html (self-contained viewer), <name>.perfetto.json (ui.perfetto.dev), <name>.model.json, <name>.rum.json and
// <name>.png. Guide: docs/telemetry_and_profiling.md "Unified client+server traces".
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { launch } from "./cdp/cdp.ts"
import { buildModel, perfetto, type CReq, type Client, type MainEv, type Mark as CMark } from "./cdp/model.ts"
import * as P from "./cdp/page.ts"
import { pullServer, ray0 } from "./cdp/server.ts"
import { viewerHtml } from "./cdp/viewer.ts"

// ---------- args ----------
const argv = process.argv.slice(2)
const flag = (k: string) => argv.includes(`--${k}`)
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d }
const target = argv.find(a => /^https?:/.test(a)) ?? "https://ephem.ivar.workers.dev/"
const deviceKey = opt("device", "iphone"), netKey = opt("net", deviceKey === "iphone" ? "fast3g" : "none")
const cpu = Number(opt("cpu", deviceKey === "iphone" ? "4" : "1")), mode: "cold" | "warm" = flag("warm") ? "warm" : "cold"
const pageKind = new URL(target).pathname.startsWith("/instrument") ? "instrument" : "home"
const script = opt("script", pageKind === "instrument" ? "instrument-sky" : "home-drag")
const durationS = Number(opt("duration", "70")), waitS = Number(opt("wait", "240"))
const [lat, lon] = opt("at", "40.7128,-74.0060").split(",").map(Number) as [number, number]
const device = P.DEVICES[deviceKey]; if (!device) throw new Error(`--device ${deviceKey}?`)
if (!(netKey in P.NETS)) throw new Error(`--net ${netKey}?`)
const net = P.NETS[netKey]!
const hexId = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), x => x.toString(16).padStart(2, "0")).join("")
const TRACE_ID = hexId(16), NAV_SPAN = hexId(8)   // the harness's navigation span: the document's root span is its child
const run = `J${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z-${Math.random().toString(36).slice(2, 6)}`
const name = opt("name", `${pageKind}-${deviceKey}-${netKey}${cpu > 1 ? `-cpu${cpu}` : ""}-${mode}`)
const outDir = opt("out", "journey-out"); mkdirSync(outDir, { recursive: true })
// A fixed public place (NYC City Hall by default), so runs are reproducible and never carry the laptop's geolocation.
const url = new URL(target); if (!url.searchParams.has("lat")) { url.searchParams.set("lat", String(lat)); url.searchParams.set("lon", String(lon)); url.searchParams.set("tz", "America/New_York") }
const origin = url.origin
const log = (...a: unknown[]) => console.error(`[${run}]`, ...a)

// ---------- drive the page ----------
interface Mark { wall: number; name: string }
const marks: Mark[] = []
const b = await launch({ headless: !flag("headed") })
let trace: P.TraceEvent[] = [], reqs: P.Req[] = [], pageState: any = {}
const tNav = { wall: 0 }
try {
  const s = await b.newPage()
  await s.send("Page.enable"); await s.send("Runtime.enable")
  await P.emulate(s, device)
  await s.send("Network.enable", {})
  await s.send("Network.setExtraHTTPHeaders", { headers: { "x-ephem-load": run } })   // front-door invocations by run; request rows say "synthetic"
  await P.cache(s, mode, origin)
  await P.throttle(s, net, cpu)
  if (mode === "warm") {   // prime: same page once, HTTP cache and connections warm; not traced
    log("warm: priming"); await P.navigate(s, url.href, { until: "networkidle", timeoutMs: 120_000 })
    await s.send("Page.navigate", { url: "about:blank" }); await new Promise(r => setTimeout(r, 500))
  }
  reqs = await P.recordNetwork(s)
  // The journey's trace id is chosen up front: the document request carries our traceparent (Fetch interception, documents
  // only, so the page's own per-fetch traceparents are untouched); the Worker adopts it and the page reuses it.
  await s.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] })
  s.on("Fetch.requestPaused", (e: any) => {
    const headers = Object.entries({ ...e.request.headers, traceparent: `00-${TRACE_ID}-${NAV_SPAN}-01` }).map(([name, value]) => ({ name, value: String(value) }))
    void s.send("Fetch.continueRequest", { requestId: e.requestId, headers }).catch(() => {})
  })
  await P.traceStart(s)
  log(`navigate ${url.href} (${device.name}, ${net?.name ?? "no throttling"}, CPU ${cpu}×, ${mode})`)
  tNav.wall = Date.now()
  await P.navigate(s, url.href, { until: "load", timeoutMs: 120_000 })
  await P.waitForFn(s, `performance.getEntriesByName("ephem:data").length`, 60_000)
  const mark = (n: string) => marks.push({ wall: Date.now(), name: n })
  await new Promise(r => setTimeout(r, 1500))
  if (script === "instrument-sky") {
    const touch = device.touch
    mark("tap SKY"); await P.tap(s, 'button[data-key="SKY"]', touch); await new Promise(r => setTimeout(r, 600))
    mark("tap AZ T (soft A)"); await P.tap(s, '.sk[data-key="SOFT0"]', touch); await new Promise(r => setTimeout(r, 600))
    mark("tap ALT (soft C)"); await P.tap(s, '.sk[data-key="SOFT2"]', touch); await new Promise(r => setTimeout(r, 600))
    mark("tap ENTER"); await P.tap(s, 'button[data-key="ENTER"]', touch); await new Promise(r => setTimeout(r, 600))
  } else if (script === "home-drag") {
    const c = await P.center(s, "canvas")
    mark("drag sky ←"); await P.drag(s, c.x + 120, c.y, -240, 0, device.touch); await new Promise(r => setTimeout(r, 800))
    mark("drag sky →"); await P.drag(s, c.x - 120, c.y, 240, 0, device.touch); await new Promise(r => setTimeout(r, 800))
  }
  await P.screenshot(s, join(outDir, `${name}.png`))
  const left = durationS * 1000 - (Date.now() - tNav.wall)
  log(`dwell ${Math.max(0, left / 1000).toFixed(0)} s (polls)`)
  if (left > 0) await new Promise(r => setTimeout(r, left))
  pageState = await P.evaluate(s, `JSON.parse(JSON.stringify({ trace: window.__ephemTrace, rum: window.__rum && window.__rum.off, instrument: window.__instrument && { calls: window.__instrument.calls, errors: window.__instrument.errors } }))`)
  // Leave the page as a user would: pagehide → the RUM's final sendBeacon (LCP, CLS, INP, the last spans).
  await s.send("Page.navigate", { url: "about:blank" }); await new Promise(r => setTimeout(r, 1500))
  trace = await P.traceEnd(s)
} finally { await b.close() }
const tEnd = Date.now()
log(`chrome done: ${trace.length} trace events, ${reqs.length} requests, RUM ${pageState?.rum ?? "on"}`)

// ---------- CDP → Client (ms since navigation start, browser clock) ----------
const navStartEv = trace.find(e => e.name === "navigationStart" && e.args?.data?.documentLoaderURL?.startsWith(origin) && e.args?.data?.isOutermostMainFrame)
const navReq = reqs.find(r => r.type === "Document" && r.url.startsWith(origin))
const T0 = navStartEv ? navStartEv.ts / 1000 : (navReq?.start ?? reqs[0]!.start) * 1000   // ms, monotonic (= trace timebase / 1000)
const rel = (monoMs: number) => +(monoMs - T0).toFixed(3)
// Network.requestWillBeSent gives wall and monotonic time at one instant: the median difference maps monotonic → wall.
const deltas = reqs.map(r => r.wallTime * 1000 - r.start * 1000).toSorted((a, b) => a - b)
const WALL = deltas[Math.floor(deltas.length / 2)]!
const pageReqs = reqs.filter(r => r.url.startsWith("http") && !(r.url === "about:blank"))
const creqs: CReq[] = pageReqs.map(r => {
  const t = r.timing, base = t ? t.requestTime * 1000 : r.start * 1000, at = (x: number) => rel(base + x)
  const ph: Record<string, [number, number]> = {}
  if (t) {
    const s0 = rel(r.start * 1000), first = [t.dnsStart, t.connectStart, t.sendStart].find(x => x >= 0) ?? t.sendStart
    if (at(first) > s0) ph.queue = [s0, at(first)]
    if (t.dnsStart >= 0 && t.dnsEnd > t.dnsStart) ph.dns = [at(t.dnsStart), at(t.dnsEnd)]
    if (t.connectStart >= 0 && t.connectEnd > t.connectStart) ph.connect = [at(t.connectStart), at(t.sslStart >= 0 ? t.sslStart : t.connectEnd)]
    if (t.sslStart >= 0 && t.sslEnd > t.sslStart) ph.ssl = [at(t.sslStart), at(t.sslEnd)]
    ph.send = [at(t.sendStart), at(t.sendEnd)]; ph.wait = [at(t.sendEnd), at(t.receiveHeadersEnd)]
    if (r.end) ph.download = [at(t.receiveHeadersEnd), rel(r.end * 1000)]
  }
  const tp = r.reqHeaders["traceparent"]
  return { url: r.url, method: r.method, type: r.type ?? "", status: r.status ?? 0, protocol: r.protocol, fromCache: r.fromCache ?? null, failed: r.failed,
    start: rel(r.start * 1000), ph, end: r.end ? rel(r.end * 1000) : null, bytes: r.encoded ?? 0, ray: r.headers["cf-ray"], cache: r.headers["x-ephem-cache"],
    version: r.headers["x-ephem-version"]?.slice(0, 8), serverTiming: r.headers["server-timing"], traceId: r.headers["x-ephem-trace"] ?? tp?.slice(3, 35), spanId: tp?.slice(36, 52),
    sendWall: t ? base + t.sendStart + WALL : undefined, headWall: t ? base + t.receiveHeadersEnd + WALL : undefined }
})

// main thread: the renderer's CrRendererMain; self time per category (nested work counted once, innermost)
const mainPid = navStartEv?.pid
const mainTid = trace.find(e => e.ph === "M" && e.name === "thread_name" && e.pid === mainPid && e.args?.name === "CrRendererMain")?.tid ?? navStartEv?.tid
const CAT: Array<[RegExp, string]> = [
  [/^(ParseHTML|ParseAuthorStyleSheet)$/, "parse"],
  [/^(EvaluateScript|v8\.compile|V8\.CompileCode|v8\.produceCache|FunctionCall|EventDispatch|TimerFire|FireAnimationFrame|v8\.run|RunMicrotasks|V8\.ParseFunction|v8\.callFunction|XHRReadyStateChange|FireIdleCallback|BlinkScheduler_PerformMicrotaskCheckpoint)$/, "script"],
  [/^(UpdateLayoutTree|RecalculateStyles|ScheduleStyleRecalculation)$/, "style"],
  [/^(Layout|UpdateLayerTree|InlineNode::ShapeTextIncludingFirstLine)$/, "layout"],
  [/^(Paint|PaintImage|PrePaint|Layerize|Commit|CompositeLayers|UpdateLayer|RasterTask|Decode Image|ImageDecodeTask)$/, "paint"],
  [/^(MinorGC|MajorGC|V8\.GC.*|BlinkGC\..*)$/, "gc"],
  [/^(ResourceReceivedData|ResourceReceiveResponse|ResourceFinish|ResourceSendRequest)$/, "net"],
]
const catOf = (n: string) => n === "RunTask" ? "task" : CAT.find(([re]) => re.test(n))?.[1] ?? "other"
const mainEv = trace.filter(e => e.pid === mainPid && e.tid === mainTid && e.ph === "X" && (e.dur ?? 0) > 0 && e.ts / 1000 >= T0 - 50).toSorted((a, z) => a.ts - z.ts || (z.dur! - a.dur!))
const dataMark = trace.find(e => e.name === "ephem:data" && e.pid === mainPid)
const tData = dataMark ? rel(dataMark.ts / 1000) : null
const stack: number[] = [], main: MainEv[] = [], selfOf: Array<{ c: string; s: number; d: number; self: number }> = [], parentIdx: number[] = []
for (const e of mainEv) {
  const s = e.ts / 1000, d = e.dur! / 1000
  while (stack.length && stack[stack.length - 1]! <= s) stack.pop()
  const depth = stack.length; stack.push(s + d)
  const n = e.name === "ThreadControllerImpl::RunTask" ? "RunTask" : e.name, c = catOf(n)
  selfOf.push({ c, s: rel(s), d, self: d }); if (parentIdx.length > depth) parentIdx.length = depth
  if (depth > 0) { const par = selfOf[parentIdx[depth - 1]!]; if (par) par.self -= d }
  parentIdx[depth] = selfOf.length - 1
  if (d >= 0.25 || (c === "task" && d >= 1) || (depth === 0 && d >= 0.1))
    main.push([rel(s), +d.toFixed(3), Math.min(depth, 5), n, e.args?.data?.url ? String(e.args.data.url).replace(origin, "") : e.args?.data?.type ?? e.args?.data?.functionName ?? ""])
}
const byCat: Record<string, number> = {}, byCatToData: Record<string, number> = {}
for (const x of selfOf) {
  const c = x.c === "task" ? "other" : x.c, self = Math.max(0, x.self)
  byCat[c] = (byCat[c] ?? 0) + self
  if (tData != null && x.s < tData) byCatToData[c] = (byCatToData[c] ?? 0) + self * Math.min(1, (tData - x.s) / Math.max(x.d, 1e-6))
}
const fcpEv = trace.find(e => e.name === "firstContentfulPaint" && e.pid === mainPid)
const lcpEv = trace.toReversed().find(e => e.name === "largestContentfulPaint::Candidate" && e.pid === mainPid)
const cmarks: CMark[] = [
  ...(fcpEv ? [{ t: rel(fcpEv.ts / 1000), name: "first contentful paint", kind: "paint" }] : []),
  ...(lcpEv ? [{ t: rel(lcpEv.ts / 1000), name: "largest contentful paint", kind: "paint" }] : []),
  ...(tData != null ? [{ t: tData, name: "data drawn (ephem:data)", kind: "data" }] : []),
  ...trace.filter(e => (e.name === "MarkDOMContent" || e.name === "MarkLoad") && e.pid === mainPid && e.args?.data?.isOutermostMainFrame).map(e => ({ t: rel(e.ts / 1000), name: e.name === "MarkLoad" ? "load" : "DOMContentLoaded", kind: "nav" })),
  ...marks.map(m => ({ t: rel(m.wall - WALL), name: m.name, kind: "input" })),
]
// Input → next paint per scripted interaction: the EventDispatch it caused, then the end of the next Paint/Commit.
const inputs = trace.filter(e => e.name === "EventDispatch" && e.pid === mainPid && /^(pointerdown|touchstart|mousedown)$/.test(e.args?.data?.type))
for (const m of cmarks.filter(m => m.kind === "input")) {
  const ev = inputs.find(e => rel(e.ts / 1000) >= m.t - 5); if (!ev) continue
  const t = rel(ev.ts / 1000), paint = main.find(x => x[0] > t && (x[3] === "Paint" || x[3] === "Commit"))
  m.t = t; m.latency = paint ? +(paint[0] + paint[1] - t).toFixed(1) : null
}
const lats = cmarks.map(m => m.latency).filter((x): x is number => x != null)
const client: Client = { source: "cdp", origin, t0Wall: T0 + WALL, traceId: TRACE_ID, reqs: creqs, main, marks: cmarks,
  fcp: fcpEv ? rel(fcpEv.ts / 1000) : null, lcp: lcpEv ? rel(lcpEv.ts / 1000) : null, data: tData, inp: lats.length ? Math.max(...lats) : null, cls: null, byCat, byCatToData }

// Independent clock check: the laptop's offset to an NTP server (sntp prints "+0.125 +/- 0.024 <host>": server − local, s).
const sntp = (() => { try { const m = /([+-][0-9.]+) \+\/- ([0-9.]+)/.exec(execFileSync("sntp", ["-t", "2", "time.apple.com"], { encoding: "utf8", timeout: 8000 })); return m ? { offsetMs: +(Number(m[1]) * 1000).toFixed(1), errMs: +(Number(m[2]) * 1000).toFixed(1), host: "time.apple.com" } : null } catch { return null } })()

// ---------- server ----------
const rays = creqs.filter(r => r.ray && r.url.startsWith(origin) && !r.fromCache).map(r => r.ray!)
const needApi = creqs.filter(r => r.ray && /^(MISS|EXPIRED|UPDATING|REVALIDATED)$/.test(r.cache ?? "")).map(r => r.ray!)
const server = await pullServer({ from: tNav.wall - 120_000, to: tEnd + 60_000, loadTag: run, clientTraceId: TRACE_ID, rays, needApi, waitS, log })
const model = buildModel(client, server, { run, url: url.pathname + url.search, origin, page: pageKind, device: device.name, net: net?.name ?? "none", cpu, mode, script, chrome: b.version.product,
  started: new Date(tNav.wall).toISOString(), durationS, navSpan: NAV_SPAN, pageTraceId: pageState?.trace?.traceId ?? null, pageTraceFrom: pageState?.trace?.from ?? null,
  documentSpan: pageState?.trace?.parentSpanId ?? null, instrument: pageState?.instrument ?? null, sntp })

// ---------- the RUM's test: production RUM rows (Basin ephem.rum) vs CDP ground truth ----------
const ROOT = new URL("../..", import.meta.url).pathname
const basin = (q: string): any[] => JSON.parse(execFileSync("python3", [join(ROOT, "scripts/obs/basin.py"), "sql", "--json", "--raw", q], { encoding: "utf8", maxBuffer: 64 << 20 }))
const fl = (v: unknown) => v == null || v === "" ? null : Number(v)
let rum: any[] = []
const expect = new Set(["navigation", "fcp", "data-ready"])
for (const t0 = Date.now(); ;) {
  try { rum = basin(`SELECT kind, name, span_id, parent_id, target, start_ms, dur_ms, value, ttfb_ms, request_ms, ray, status, synthetic, seq FROM ephem.rum WHERE trace_id = '${TRACE_ID}'`) } catch (e) { log(`basin: ${String(e).slice(0, 200)}`) }
  const have = new Set(rum.map(r => r.kind === "navigation" ? "navigation" : r.name))
  log(`RUM rows in Basin: ${rum.length} (${[...expect].filter(x => have.has(x)).length}/${expect.size} key spans)`)
  if ([...expect].every(x => have.has(x)) && rum.some(r => r.name === "lcp")) break
  if (Date.now() - t0 > waitS * 1000) { log("RUM wait reached"); break }
  await new Promise(r => setTimeout(r, 15_000))
}
const checks: Array<{ what: string; rum: number; cdp: number; diff: number }> = []
const chk = (what: string, a: number | null, z: number | null | undefined) => { if (a != null && z != null) checks.push({ what, rum: a, cdp: +z.toFixed(2), diff: +(a - z).toFixed(2) }) }
const fcpRow = rum.find(r => r.kind === "paint" && r.name === "fcp"); chk("FCP", fl(fcpRow?.start_ms), client.fcp)
const lcpRow = rum.find(r => r.kind === "lcp"); chk("LCP", fl(lcpRow?.value), client.lcp)
const dr = rum.find(r => r.kind === "app" && r.name === "data-ready"); chk("data-ready vs ephem:data", fl(dr?.start_ms), client.data)
const navRow = rum.find(r => r.kind === "navigation"), docC = creqs.find(r => r.type === "Document")
if (navRow && docC?.ph.wait) chk("document TTFB (responseStart)", fl(navRow.ttfb_ms), docC.ph.wait[1] - 0)
for (const r of rum.filter(x => x.kind === "resource" && x.ray)) {
  const c = creqs.find(q => q.ray && ray0(q.ray) === ray0(r.ray)); if (!c) continue
  chk(`start ${r.target}`, fl(r.start_ms), c.start); if (c.ph.wait) chk(`first byte ${r.target}`, fl(r.start_ms)! + fl(r.ttfb_ms)!, c.ph.wait[1])
  if (c.end != null) chk(`end ${r.target}`, fl(r.start_ms)! + fl(r.dur_ms)!, c.end)
}
for (const r of rum.filter(x => x.kind === "fetch")) { const c = creqs.find(q => q.spanId === r.span_id); if (c) chk(`fetch span ${r.target} start (traceparent ${r.span_id.slice(0, 6)})`, fl(r.start_ms), c.start) }
const absd = checks.map(x => Math.abs(x.diff)).toSorted((a, z) => a - z)
const TOL = 10
const rumCheck = { rows: rum.length, kinds: Object.fromEntries([...new Set(rum.map(r => r.kind))].map(k => [k, rum.filter(r => r.kind === k).length])), synthetic: rum.every(r => r.synthetic === "true"),
  checks: checks.length, within: absd.filter(x => x <= TOL).length, tolMs: TOL, p50: absd[Math.floor(absd.length / 2)] ?? null, max: absd[absd.length - 1] ?? null,
  worst: checks.toSorted((a, z) => Math.abs(z.diff) - Math.abs(a.diff)).slice(0, 5),
  fetchRows: rum.filter(r => r.kind === "fetch").length, fetchesCdp: creqs.filter(r => r.spanId && r.type !== "Document").length,
  resourcesWithRay: rum.filter(r => r.kind === "resource" && r.ray).length, resources: rum.filter(r => r.kind === "resource").length }
;(model.meta as any).rum = rumCheck
writeFileSync(join(outDir, `${name}.rum.json`), JSON.stringify({ rumCheck, checks, rows: rum }, null, 1))

// ---------- outputs ----------
writeFileSync(join(outDir, `${name}.model.json`), JSON.stringify(model, null, 1))
writeFileSync(join(outDir, `${name}.html`), viewerHtml(model, name))
const keepPids = new Set([mainPid, ...trace.filter(e => e.ph === "M" && e.name === "process_name" && /Browser|GPU/.test(e.args?.name)).map(e => e.pid)])
// Chrome's own events keep their µs timebase; the model's tracks are placed on it (navigation start = T0).
writeFileSync(join(outDir, `${name}.perfetto.json`), JSON.stringify(perfetto(model, trace.filter(e => keepPids.has(e.pid)), x => Math.round((x + T0) * 1000))))

// ---------- report ----------
const f = (x: number | null | undefined) => x == null ? "–" : `${x.toFixed(0)} ms`
const { kpi, offset, coverage } = model
console.log(`\n${name}  run ${run}  ${url.pathname}  ${device.name} · ${net?.name ?? "no throttling"} · CPU ${cpu}× · ${mode}  ephem ${model.meta.versions.join(",")}  trace ${TRACE_ID}`)
console.log(`TTFB ${f(kpi.ttfb)}  FCP ${f(kpi.fcp)}  LCP ${f(kpi.lcp)}  data drawn ${f(kpi.data)}  INP(scripted) ${f(kpi.inp)}  requests ${kpi.requests}  server CPU ${kpi.serverCpu} ms / ${kpi.invocations} invocations  cache ${JSON.stringify(kpi.cache)} blocks ${JSON.stringify(kpi.blocks)}`)
console.log(`clock offset θ (server − client) = ${offset.thetaMs} ± ${offset.plusMinusMs} ms from ${offset.n} requests${offset.consistent ? "" : " (INCONSISTENT: tightest single request used)"}; tightest ${offset.tightest?.path} ${offset.tightest?.widthMs} ms wide`)
if (sntp) console.log(`independent check: sntp ${sntp.host} says server − laptop = ${sntp.offsetMs} ± ${sntp.errMs} ms (NTP is not the Workers clock; agreement within both errors is the check)`)
console.log(`server root span inside its request's send → first byte (± uncertainty): ${model.inside.ok}/${model.inside.n}`)
console.log(`coverage: ${coverage.joined} of ${coverage.total} requests joined to a server invocation (${coverage.byTrace} by trace id + ray)${coverage.unjoined.length ? "; unjoined: " + coverage.unjoined.map(u => `#${u.i} ${u.url} (${u.reason})`).join("; ") : ""}`)
console.log(`propagation: page trace ${pageState?.trace?.traceId === TRACE_ID ? "=" : "≠"} harness trace (from ${pageState?.trace?.from}); ${coverage.fetchesSameTrace}/${coverage.fetches} fetches carried it`)
console.log(`RUM: ${rumCheck.rows} rows ${JSON.stringify(rumCheck.kinds)}; ${rumCheck.within}/${rumCheck.checks} timings within ${TOL} ms of CDP (p50 ${rumCheck.p50} ms, max ${rumCheck.max} ms); fetch rows ${rumCheck.fetchRows}/${rumCheck.fetchesCdp}; resources with ray ${rumCheck.resourcesWithRay}/${rumCheck.resources}`)
console.log("top client costs:"); for (const c of model.costs.slice(0, 5)) console.log(`  ${c.ms.toFixed(0).padStart(6)} ms  ${c.what} — ${c.detail}`)
console.log(`→ ${join(outDir, name)}.{html,perfetto.json,model.json,rum.json,png}`)
