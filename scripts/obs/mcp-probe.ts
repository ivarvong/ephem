// Full MCP client session against a base URL, no deps: legacy handshake (initialize → notifications/initialized → tools/list
// → tools/call each tool → ping), the modern 2026-07-28 per-request flow (server/discover → tools/list → tools/call each tool),
// and the error cases. Every tool call is checked against the REST endpoint for the same inputs. Prints a pass/fail table.
//   node --experimental-strip-types scripts/obs/mcp-probe.ts [base] [--quiet]
// JSON-RPC ids are "<run>-<step>", so `python3 scripts/obs/trace.py --jsonrpc-id <run>-<step>` (or a query on jsonrpc.id)
// finds the trace of any step.
const base = (process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "https://ephem.ivar.workers.dev").replace(/\/$/, "")
const run = `p${Date.now().toString(36)}`
// EPHEM_VERSION=<version uuid>: pin every request to that version (Cloudflare-Workers-Version-Overrides; scripts/smoke.sh,
// deploy.sh's 0% canary) and fail any response whose x-ephem-version is another version.
// EPHEM_COMPUTE_VERSION=<uuid>: also pin ephem-compute (the front door forwards the header over the service binding).
const PIN = process.env.EPHEM_VERSION || undefined, CPIN = process.env.EPHEM_COMPUTE_VERSION || undefined, offPin: string[] = []
const OVR = [PIN && `ephem="${PIN}"`, CPIN && `ephem-compute="${CPIN}"`].filter(Boolean).join(", ")
// EPHEM_SMOKE_RUN=<id>: send x-ephem-smoke: <id> (scripts/obs/canary-gate.py selects the smoke's invocations by it);
// EPHEM_SMOKE_MANIFEST=<file>: append `<cf-ray> <status> <method> <path> mcp-probe` per request (smoke.sh --manifest).
const RUN = process.env.EPHEM_SMOKE_RUN || undefined, MANIFEST = process.env.EPHEM_SMOKE_MANIFEST || undefined, isoErr: string[] = []
if (OVR || RUN || MANIFEST) {
  const f = globalThis.fetch
  const { appendFileSync } = await import("node:fs")
  globalThis.fetch = (async (u: string | URL | Request, init: RequestInit = {}) => {
    const r = await f(u, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), ...(OVR ? { "cloudflare-workers-version-overrides": OVR } : {}), ...(RUN ? { "x-ephem-smoke": RUN } : {}) } })
    const v = r.headers.get("x-ephem-version"); if (PIN && v !== PIN) offPin.push(`${String(u).replace(base, "")} → ${v}`)
    const er = r.headers.get("x-ephem-errors"); if (PIN && RUN && er && er !== "0") isoErr.push(`${String(u).replace(base, "")} → ${er}`)
    if (MANIFEST) appendFileSync(MANIFEST, `${r.headers.get("cf-ray") || "-"} ${r.status} ${init.method ?? "GET"} ${new URL(String(u)).pathname} mcp-probe\n`)
    return r
  }) as typeof fetch
}
const LATEST = "2026-07-28", LEGACY = "2025-11-25"
const day = new Date(Date.now() + 86_400_000 * (1 + Math.floor(Math.random() * 300))).toISOString().slice(0, 10)   // fresh day: response cache miss
const ARGS = {
  sun_moon_position: { lat: 40.7127, lon: -74.0059, height: -22.6, time: "2026-10-28T11:51:00Z" },
  day_events: { lat: 40.7127 + Math.random() / 100, lon: -74.0059, date: day, tz: "America/New_York", height: 320, heightRef: "msl", temperature: -5, pressure: 1025, limb: "upper" },
  crossing: { lat: 40.7484, lon: -73.9857, body: "sun", altitude: -0.927, direction: "set", date: day, tz: "America/New_York", height: 320, heightRef: "msl" },
  alignment: { body: "moon", targetLat: 40.68925, targetLon: -74.0445, targetHeight: 70, targetHeightRef: "msl", observerHeight: 5, heightRef: "msl", start: "2026-11-17T03:44:30Z", end: "2026-11-17T03:46:00Z", stepSeconds: 30, maxDistanceKm: 8, aim: "litCentroid", include: "sun,phase" },
  sight_line: { observerLat: 40.6935, observerLon: -74.0017, observerHeight: 5, heightRef: "msl", targetLat: 40.68925, targetLon: -74.0445, targetHeight: 70, targetHeightRef: "msl", samples: 11, obstacles: "40.6894:-74.0166:25" },
  sun_moon_track: { lat: 40.7127, lon: -74.0059, height: -22.6, start: "2026-10-28T00:00:00Z", end: "2026-10-29T00:00:00Z", stepSeconds: 1200 },
  alignment_search: { body: "moon", target: { lat: 40.68925, lon: -74.0445, height: 70, heightRef: "msl" }, region: [-73.9995, 40.7, -73.993, 40.706], observerHeight: 5, heightRef: "msl", start: "2026-11-16T00:00:00Z", end: "2026-11-18T00:00:00Z", include: ["phase"] },
  weather_nearest: { lat: 40.7, lon: -74, n: 3 },
} as const
const REST_PATH: Record<string, string> = { sun_moon_position: "/v1/position", day_events: "/v1/day", crossing: "/v1/crossing", alignment: "/v1/alignment", sight_line: "/v1/sightline", sun_moon_track: "/v1/track", weather_nearest: "/v1/weather", alignment_search: "/v1/alignment/search" }
const POST_TOOLS = new Set(["alignment_search"])   // JSON body, not a query

type Row = { step: string; expect: string; got: string; ok: boolean; ms: number; ray: string }
const rows: Row[] = []
const meta = { "io.modelcontextprotocol/protocolVersion": LATEST, "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "mcp-probe", version: run } }

async function send(body: unknown, headers: Record<string, string> = {}, method = "POST") {
  const t0 = performance.now()
  const r = await fetch(`${base}/mcp`, { method, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) })
  const text = await r.text(), ms = performance.now() - t0
  let json: any; try { json = text ? JSON.parse(text) : undefined } catch { json = undefined }
  return { status: r.status, json, text, ms, ray: r.headers.get("cf-ray") ?? "", headers: r.headers }
}
const rpc = (step: string, method: string, params?: Record<string, unknown>, headers: Record<string, string> = {}) =>
  send({ jsonrpc: "2.0", id: `${run}-${step}`, method, ...(params ? { params } : {}) }, headers)
const modern = (step: string, method: string, params: Record<string, unknown> = {}) =>
  rpc(step, method, { ...params, _meta: meta }, { "mcp-protocol-version": LATEST, "mcp-method": method, ...(typeof params.name === "string" ? { "mcp-name": params.name } : {}) })
const legacy = (step: string, method: string, params?: Record<string, unknown>) => rpc(step, method, params, { "mcp-protocol-version": LEGACY })
const check = (step: string, expect: string, r: { status: number; ms: number; ray: string }, ok: boolean, got: string) => rows.push({ step, expect, got: `${r.status} ${got}`, ok, ms: r.ms, ray: r.ray })

/** Inputs-only part of a response: provenance has cache tiers and timings; weather ages move with the clock. */
const comparable = (tool: string, x: any) => tool === "weather_nearest" ? JSON.stringify({ s: x?.stations?.map((s: any) => s.raw), o: { ...x?.observer, magneticDeclination: x?.observer?.magneticDeclination?.toFixed(4) } })   // full-precision declination moves ~1e-12° between calls
  : JSON.stringify(x, (k, v) => (k === "provenance" ? undefined : v))
async function restOf(tool: string) {
  const q = new URLSearchParams(Object.entries(ARGS[tool as keyof typeof ARGS]).map(([k, v]) => [k, String(v)]))
  const t0 = performance.now(), r = POST_TOOLS.has(tool)
    ? await fetch(`${base}${REST_PATH[tool]}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ARGS[tool as keyof typeof ARGS]) })
    : await fetch(`${base}${REST_PATH[tool]}?${q}`)
  return { status: r.status, json: await r.json(), ms: performance.now() - t0 }
}
async function toolCall(era: "legacy" | "modern", tool: string) {
  const step = `${era}.call.${tool}`
  const r = era === "modern" ? await modern(step, "tools/call", { name: tool, arguments: ARGS[tool as keyof typeof ARGS] }) : await legacy(step, "tools/call", { name: tool, arguments: ARGS[tool as keyof typeof ARGS] })
  const res = r.json?.result, sc = res?.structuredContent
  const rest = await restOf(tool)
  const same = rest.status === 200 && comparable(tool, sc) === comparable(tool, rest.json)
  const textSame = res?.content?.[0]?.type === "text" && res.content[0].text === JSON.stringify(sc)
  check(step, "isError=false, == REST", r, r.status === 200 && res?.isError === false && same && textSame,
    `isError=${res?.isError} rest=${rest.status} ${same ? "equal" : "DIFFERENT"}${textSame ? "" : " text≠structured"} (rest ${rest.ms.toFixed(0)}ms)`)
}

// ── legacy session (initialize-era clients: today's SDKs, Inspector, Claude Code) ──
const init = await rpc("legacy.initialize", "initialize", { protocolVersion: LEGACY, capabilities: {}, clientInfo: { name: "mcp-probe", version: run } })
check("legacy.initialize", `protocolVersion ${LEGACY}`, init, init.status === 200 && init.json?.result?.protocolVersion === LEGACY && !init.headers.get("mcp-session-id"),
  `${init.json?.result?.protocolVersion} server=${init.json?.result?.serverInfo?.name}/${init.json?.result?.serverInfo?.version}`)
const notif = await send({ jsonrpc: "2.0", method: "notifications/initialized" }, { "mcp-protocol-version": LEGACY })
check("legacy.notifications/initialized", "202, empty", notif, notif.status === 202 && notif.text === "", `body=${JSON.stringify(notif.text)}`)
const ltl = await legacy("legacy.tools/list", "tools/list")
const names: string[] = ltl.json?.result?.tools?.map((t: any) => t.name) ?? []
check("legacy.tools/list", "8 tools with schemas", ltl, names.length === 8 && ltl.json.result.tools.every((t: any) => t.inputSchema?.type === "object" && t.outputSchema?.type === "object"), names.join(","))
for (const t of names) await toolCall("legacy", t)
const ping = await legacy("legacy.ping", "ping")
check("legacy.ping", "result {}", ping, ping.status === 200 && JSON.stringify(ping.json?.result) === "{}", JSON.stringify(ping.json?.result))

// ── modern 2026-07-28 (stateless, per-request _meta) ──
const disc = await modern("modern.server/discover", "server/discover")
check("modern.server/discover", "supportedVersions[0]=2026-07-28", disc, disc.status === 200 && disc.json?.result?.supportedVersions?.[0] === LATEST && disc.json.result.resultType === "complete", disc.json?.result?.supportedVersions?.join(","))
const mtl = await modern("modern.tools/list", "tools/list")
check("modern.tools/list", "same tools, ttlMs", mtl, mtl.status === 200 && JSON.stringify(mtl.json?.result?.tools) === JSON.stringify(ltl.json?.result?.tools) && mtl.json.result.ttlMs > 0, `${mtl.json?.result?.tools?.length} tools ttlMs=${mtl.json?.result?.ttlMs}`)
for (const t of names) await toolCall("modern", t)

// ── errors ──
const pe = await send("{nope", { "mcp-protocol-version": LEGACY })
check("err.parse", "400 -32700", pe, pe.status === 400 && pe.json?.error?.code === -32700, `code=${pe.json?.error?.code}`)
const um = await legacy("err.unknown_method", "resources/list")
check("err.unknown_method(legacy)", "-32601", um, um.json?.error?.code === -32601, `code=${um.json?.error?.code}`)
const umm = await modern("err.unknown_method_modern", "resources/list")
check("err.unknown_method(modern)", "404 -32601", umm, umm.status === 404 && umm.json?.error?.code === -32601, `code=${umm.json?.error?.code}`)
const ut = await modern("err.unknown_tool", "tools/call", { name: "nope", arguments: {} })
check("err.unknown_tool", "-32602", ut, ut.json?.error?.code === -32602, `code=${ut.json?.error?.code} ${ut.json?.error?.message}`)
const ip = await legacy("err.invalid_params", "tools/call", { arguments: {} })
check("err.invalid_params", "-32602", ip, ip.json?.error?.code === -32602, `code=${ip.json?.error?.code}`)
const ba = await modern("err.bad_args", "tools/call", { name: "sun_moon_position", arguments: { lat: 91, lon: 0 } })
check("err.bad_args", "isError=true", ba, ba.json?.result?.isError === true, (ba.json?.result?.content?.[0]?.text ?? "").slice(0, 60).replace(/\n/g, " "))
const oor = await modern("err.out_of_range", "tools/call", { name: "sun_moon_position", arguments: { lat: 0, lon: 0, time: "1960-01-01T00:00:00Z" } })
check("err.out_of_range", "isError=true OutOfRange", oor, oor.json?.result?.isError === true && /^OutOfRange/.test(oor.json.result.content[0].text), oor.json?.result?.content?.[0]?.text?.slice(0, 60))
const ver = await send({ jsonrpc: "2.0", id: `${run}-err.version`, method: "tools/list", params: { _meta: { ...meta, "io.modelcontextprotocol/protocolVersion": "1900-01-01" } } }, { "mcp-protocol-version": "1900-01-01", "mcp-method": "tools/list" })
check("err.unsupported_version", "400 -32022", ver, ver.status === 400 && ver.json?.error?.code === -32022, `code=${ver.json?.error?.code} supported=${ver.json?.error?.data?.supported}`)
const hm = await send({ jsonrpc: "2.0", id: `${run}-err.header`, method: "tools/list", params: { _meta: meta } }, { "mcp-protocol-version": LATEST, "mcp-method": "tools/call" })
check("err.header_mismatch", "400 -32020", hm, hm.status === 400 && hm.json?.error?.code === -32020, `code=${hm.json?.error?.code}`)
const batch = await send([{ jsonrpc: "2.0", id: `${run}-b1`, method: "ping" }], { "mcp-protocol-version": LEGACY })
check("err.batch(2025-11-25)", "400 -32600", batch, batch.status === 400 && batch.json?.error?.code === -32600, `code=${batch.json?.error?.code}`)
const b03 = await send([{ jsonrpc: "2.0", id: `${run}-b2`, method: "ping" }, { jsonrpc: "2.0", method: "notifications/initialized" }])
check("batch(2025-03-26, no header)", "200 [1 reply]", b03, b03.status === 200 && Array.isArray(b03.json) && b03.json.length === 1, JSON.stringify(b03.json))
const xa = await modern("err.excess_arg", "tools/call", { name: "day_events", arguments: { lat: 40.7, lon: -74, date: day, tz: "America/New_York", temprature: -20 } })
check("err.excess_arg", "isError=true (unknown argument)", xa, xa.json?.result?.isError === true, (xa.json?.result?.content?.[0]?.text ?? "").slice(0, 60).replace(/\n/g, " "))
const unk = await fetch(`${base}/v1/day?lat=40.7&lon=-74&date=${day}&tz=America/New_York&temprature=-20`), unkBody: any = await unk.json().catch(() => ({}))
check("rest.unknown_param", "400 UnknownParameter + allowed", { status: unk.status, ms: 0, ray: unk.headers.get("cf-ray") ?? "" },
  unk.status === 400 && unkBody?.kind === "UnknownParameter" && unkBody?.unknown?.[0] === "temprature" && unkBody?.allowed?.includes("temperature"), `${unkBody?.kind} ${JSON.stringify(unkBody?.unknown)}`)
const nullPos: any = await (await fetch(`${base}/v1/position?lat=40.7484&lon=-73.9857&time=2026-10-30T05:00:00Z`)).json()
check("rest.position_below_horizon", "sun.apparentAltitude null + conventions", { status: 200, ms: 0, ray: "" },
  nullPos?.sun?.apparentAltitude === null && typeof nullPos?.sun?.altitudeRate === "number" && nullPos?.conventions?.horizon?.kind === "sea" && typeof nullPos?.observer?.geoidUndulation === "number",
  `alt=${nullPos?.sun?.altitude?.toFixed?.(2)} app=${nullPos?.sun?.apparentAltitude} N=${nullPos?.observer?.geoidUndulation?.toFixed?.(2)}`)
const get = await send(undefined, { accept: "text/event-stream" }, "GET")
check("err.GET", "405", get, get.status === 405, `allow=${get.headers.get("allow")}`)
const org = await send({ jsonrpc: "2.0", id: `${run}-err.origin`, method: "ping" }, { origin: "http://evil.example", "mcp-protocol-version": LEGACY })
check("err.bad_origin", "403", org, org.status === 403, "")
const pre = await fetch(`${base}/mcp`, { method: "OPTIONS", headers: { origin: "https://example.com", "access-control-request-method": "POST", "access-control-request-headers": "content-type,mcp-protocol-version" } })
check("cors.preflight", "allows POST", { status: pre.status, ms: 0, ray: pre.headers.get("cf-ray") ?? "" }, /POST/.test(pre.headers.get("access-control-allow-methods") ?? ""), pre.headers.get("access-control-allow-methods") ?? "")

const w = Math.max(...rows.map(r => r.step.length)), we = Math.max(...rows.map(r => r.expect.length))
console.log(`mcp-probe ${run} → ${base}/mcp   (jsonrpc ids: ${run}-<step>)\n`)
console.log(`${"step".padEnd(w)}  ${"expect".padEnd(we)}  ok    ms    ray               got`)
for (const r of rows) console.log(`${r.step.padEnd(w)}  ${r.expect.padEnd(we)}  ${r.ok ? "PASS" : "FAIL"} ${r.ms.toFixed(0).padStart(5)}  ${r.ray.padEnd(16)}  ${r.got}`)
if (PIN && RUN) rows.push({ step: "isolate.errors", expect: "x-ephem-errors 0 on every response", got: isoErr.length ? `${isoErr.length} non-zero: ${isoErr[0]}` : "all 0", ok: isoErr.length === 0, ms: 0, ray: "" })
if (PIN) rows.push({ step: "version.pinned", expect: `every response from ${PIN.slice(0, 8)}`, got: offPin.length ? `${offPin.length} off: ${offPin[0]}` : "all", ok: offPin.length === 0, ms: 0, ray: "" })
const failed = rows.filter(r => !r.ok).length
console.log(`\n${rows.length - failed}/${rows.length} passed`)
process.exit(failed ? 1 : 0)
