// A real page view, reconstructed from production telemetry alone, by trace id: the page's own RUM rows (Basin ephem.rum),
// the server's request rows (ephem.requests_v2, same trace_id) and every invocation and span in Workers Observability (spans
// with client.trace_id, rays from the RUM's `ray;desc` Server-Timing). No harness, no CDP. Same viewer as scripts/obs/journey.ts.
//   node --experimental-strip-types scripts/obs/trace-view.ts <trace-id> [--out dir] [--name base] [--origin https://ephem.ivar.workers.dev] [--wait 60]
//   node --experimental-strip-types scripts/obs/trace-view.ts --latest [--real]   # newest RUM trace (--real: synthetic = false)
// Writes <name>.html (self-contained viewer), <name>.perfetto.json and <name>.model.json.
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildModel, perfetto, type CReq, type Client, type MainEv, type Mark } from "./cdp/model.ts"
import { pullServer } from "./cdp/server.ts"
import { viewerHtml } from "./cdp/viewer.ts"

const argv = process.argv.slice(2)
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d }
const ROOT = new URL("../..", import.meta.url).pathname
const basin = (q: string): any[] => JSON.parse(execFileSync("python3", [join(ROOT, "scripts/obs/basin.py"), "sql", "--json", "--raw", q], { encoding: "utf8", maxBuffer: 64 << 20 }))
const log = (...a: unknown[]) => console.error("[trace-view]", ...a)
let traceId = argv.find(a => /^[0-9a-f]{32}$/.test(a))
if (!traceId && argv.includes("--latest")) {
  const r = basin(`SELECT trace_id, MAX(ts) AS t FROM ephem.rum WHERE kind = 'navigation'${argv.includes("--real") ? " AND synthetic = false" : ""} GROUP BY trace_id ORDER BY t DESC LIMIT 1`)
  traceId = r[0]?.trace_id
}
if (!traceId) throw new Error("give a 32-hex trace id, or --latest [--real]")
const origin = opt("origin", "https://ephem.ivar.workers.dev"), outDir = opt("out", "journey-out"), waitS = Number(opt("wait", "60"))
mkdirSync(outDir, { recursive: true })

// ---------- Basin ----------
const rows = basin(`SELECT * FROM ephem.rum WHERE trace_id = '${traceId}' ORDER BY seq, start_ms`)
if (!rows.length) throw new Error(`no ephem.rum rows for ${traceId} (rows land in Iceberg about every 60 s)`)
const v2 = basin(`SELECT ts, route, status, ray, role, api_cache, blocks_cache, span_id, client_span_id, client_parent_id, trace_origin, synthetic FROM ephem.requests_v2 WHERE trace_id = '${traceId}'`)
log(`${rows.length} RUM rows, ${v2.length} requests_v2 rows`)
const n = (v: unknown) => v == null || v === "" ? null : Number(v)
// One row per span; a span id can appear twice (a fetch's app-level "fetch" row and its Resource Timing row): keep both kinds.
const seen = new Set<string>(), R = rows.filter(r => { const k = r.kind + r.span_id; if (seen.has(k)) return false; seen.add(k); return true })
const page = R[0]!.page as string, t0Wall = Date.parse(R.find(r => r.time_origin)?.time_origin ?? R[0]!.ts)

// ---------- RUM → Client ----------
const typeOf = (r: any) => r.kind === "navigation" ? "Document" : (r.target ?? "").endsWith(".woff2") ? "Font" : r.name === "fetch" ? "Fetch" : r.name === "link" || r.name === "css" ? "Stylesheet" : "Other"
const reqOf = (r: any): CReq => {
  const s = n(r.start_ms) ?? 0, ttfb = n(r.ttfb_ms), reqMs = n(r.request_ms), dl = n(r.download_ms)
  const ph: Record<string, [number, number]> = {}
  let t = s
  for (const [k, v] of [["dns", n(r.dns_ms)], ["connect", n(r.connect_ms)], ["ssl", n(r.tls_ms)]] as const) if (v) { ph[k] = [t, t + v]; t += v }
  const head = ttfb != null ? s + ttfb : null, sent = head != null && reqMs != null ? head - reqMs : null
  if (sent != null && sent > t + 0.05) ph.queue = [t, sent]
  if (sent != null && head != null) { ph.send = [sent, sent]; ph.wait = [sent, head] }
  if (head != null && dl != null) ph.download = [head, head + dl]
  const end = r.kind === "navigation" ? (head != null && dl != null ? head + dl : null) : n(r.dur_ms) != null ? s + n(r.dur_ms)! : null
  const fetchSpan = r.name === "fetch" && R.some(x => x.kind === "fetch" && x.span_id === r.span_id)
  const tb = n(r.transfer_bytes)
  return { url: origin + (r.kind === "navigation" ? page : r.target === "external" ? "/external" : r.target ?? "/other"), method: "GET", type: typeOf(r), status: n(r.status) ?? 0,
    protocol: r.protocol ?? undefined, fromCache: tb === 0 && !r.ray ? "disk (transferSize 0)" : null, start: s, ph, end, bytes: tb ?? 0, ray: r.ray ?? undefined, cache: r.cache ?? undefined,
    serverTiming: r.server_timing ?? undefined, traceId, spanId: r.kind === "navigation" ? r.span_id : fetchSpan ? r.span_id : undefined,
    sendWall: sent != null ? t0Wall + sent : undefined, headWall: head != null ? t0Wall + head : undefined }
}
const reqs = R.filter(r => r.kind === "navigation" || r.kind === "resource").map(reqOf).toSorted((a, z) => a.start - z.start)
const main: MainEv[] = []
for (const r of R) {
  const s = n(r.start_ms) ?? 0, d = n(r.dur_ms) ?? 0
  if (r.kind === "loaf") main.push([s, d, 0, "LoAF", `long animation frame, blocking ${n(r.value) ?? 0} ms`])
  else if (r.kind === "longtask") main.push([s, d, 0, "longtask", ""])
  else if (r.kind === "event") main.push([s, d, 1, "EventDispatch", `${r.name}, input delay ${n(r.value) ?? "?"} ms`])
  else if ((r.kind === "app" || r.kind === "interaction") && d > 0) main.push([s, d, 1, `FunctionCall`, `${r.kind}: ${r.name}${r.detail ? " " + r.detail : ""}`])
}
main.sort((a, z) => a[0] - z[0])   // oxlint-disable-line unicorn/no-array-sort
const one = (k: string, name?: string) => R.find(r => r.kind === k && (!name || r.name === name))
const marks: Mark[] = []
const fcp = n(one("paint", "fcp")?.start_ms), lcp = n(one("lcp")?.value), data = n(one("app", "data-ready")?.start_ms)
if (fcp != null) marks.push({ t: fcp, name: "first contentful paint", kind: "paint" })
if (lcp != null) marks.push({ t: lcp, name: "largest contentful paint", kind: "paint" })
if (data != null) marks.push({ t: data, name: "data ready", kind: "data" })
const sky = n(one("app", "first-sky-draw")?.start_ms); if (sky != null) marks.push({ t: sky, name: "first sky draw", kind: "paint" })
for (const r of R.filter(x => x.kind === "interaction")) marks.push({ t: n(r.start_ms)!, name: `${r.name}${r.detail ? " " + r.detail : ""}`, kind: "input", latency: n(r.dur_ms) })
const inpRow = one("inp")
if (inpRow) marks.push({ t: n(inpRow.start_ms)!, name: `INP ${inpRow.name}`, kind: "input", latency: n(inpRow.value) })
const client: Client = { source: "rum", origin, t0Wall, traceId, reqs, main, marks, fcp, lcp, data, inp: n(inpRow?.value), cls: n(one("cls")?.value), byCat: {}, byCatToData: {} }

// ---------- server ----------
const rays = reqs.filter(r => r.ray).map(r => r.ray!)
const last = Math.max(...R.map(r => (n(r.start_ms) ?? 0) + (n(r.dur_ms) ?? 0)))
const server = await pullServer({ from: t0Wall - 60_000, to: t0Wall + last + 120_000, clientTraceId: traceId, rays, waitS, log })
const synthetic = R.some(r => r.synthetic === "true")
const model = buildModel(client, server, { page: page === "/instrument" ? "instrument" : "home", url: page, client: `${R[0]!.ua_family}, ${R[0]!.vw} px @${R[0]!.dpr}x, ${R[0]!.colo ?? "?"}${synthetic ? ", synthetic" : ", real user"}`,
  started: new Date(t0Wall).toISOString(), durationS: Math.round(last / 1000), basin: { rum: rows.length, requestsV2: v2.length, v2Routes: v2.map(x => x.route) } })
const name = opt("name", `rum-${page === "/" ? "home" : "instrument"}-${traceId.slice(0, 8)}`)
writeFileSync(join(outDir, `${name}.model.json`), JSON.stringify(model, null, 1))
writeFileSync(join(outDir, `${name}.html`), viewerHtml(model, name))
writeFileSync(join(outDir, `${name}.perfetto.json`), JSON.stringify(perfetto(model)))
const f = (x: number | null | undefined) => x == null ? "–" : `${x.toFixed(0)} ms`
const { kpi, coverage, offset } = model
console.log(`\n${name}  trace ${traceId}  ${page}  ${(model.meta as any).client}  ephem ${model.meta.versions.join(",")}`)
console.log(`TTFB ${f(kpi.ttfb)}  FCP ${f(kpi.fcp)}  LCP ${f(kpi.lcp)}  data ready ${f(kpi.data)}  INP ${f(kpi.inp)}  CLS ${kpi.cls ?? "–"}  requests ${kpi.requests}  server CPU ${kpi.serverCpu} ms / ${kpi.invocations} invocations`)
console.log(`clock offset θ = ${offset.thetaMs} ± ${offset.plusMinusMs} ms from ${offset.n} requests; server spans inside their request: ${model.inside.ok}/${model.inside.n}`)
console.log(`coverage: ${coverage.joined} of ${coverage.total} requests joined (${coverage.byTrace} by trace id)${coverage.unjoined.length ? "; unjoined: " + coverage.unjoined.map(u => `#${u.i} ${u.url} (${u.reason})`).join("; ") : ""}`)
console.log(`Basin: ${rows.length} RUM rows, ${v2.length} requests_v2 rows (${[...new Set(v2.map(x => x.route))].join(", ")})`)
console.log(`→ ${join(outDir, name)}.{html,perfetto.json,model.json}`)
