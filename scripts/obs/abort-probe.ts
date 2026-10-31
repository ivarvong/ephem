// Client disconnects on purpose: open a TLS connection, send a request, and drop the socket at a chosen point, so the
// telemetry of an aborted request can be read (and the gate checked against it). No deps.
//   node --experimental-strip-types scripts/obs/abort-probe.ts [base] [--run id] [--pin <version id>] [--only a,b] [--delay ms]
// Every request carries `x-ephem-smoke: <run>` (find them: `$workers.event.request.headers.x-ephem-smoke`). Prints one line
// per case: `<case> <cf-ray or -> <what the client saw>`. Cases:
//   mcp-body      POST /mcp, headers + half the body, then close (measured 2026-10-31: the edge never invokes the Worker)
//   mcp-response  POST /mcp tools/call track (fresh key, ~300 ms), close --delay ms after sending (before the answer)
//   mcp-fast      POST /mcp tools/call position (now: computed in the front door, ~10-30 ms), close --delay ms after sending
//   home-stream   GET /, read the first response bytes of the streamed page, then close
//   api-fast      GET /v1/position (now: computed in the front door, ~10-30 ms), close --delay ms after sending
//   api-response  GET /v1/track (a slow-ish deterministic answer, fresh key), close at once
import * as tls from "node:tls"

const args = process.argv.slice(2)
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined }
const base = new URL(args[0] && !args[0].startsWith("--") ? args[0] : "https://ephem.ivar.workers.dev")
const run = flag("--run") ?? `abort-${Date.now().toString(36)}`, pin = flag("--pin"), only = flag("--only")?.split(",")
const delay = Number(flag("--delay") ?? 60)   // ms between the last byte sent and the close ("sent" cases)
const day = `20${30 + Math.floor(Math.random() * 60)}-0${1 + Math.floor(Math.random() * 9)}-1${Math.floor(Math.random() * 9)}`   // fresh key: a cache MISS computed by the Api
// tools/call track (~300 ms: forwarded to the Api), so the client is gone before the answer
const body = JSON.stringify({ jsonrpc: "2.0", id: `${run}-1`, method: "tools/call", params: { name: "track", arguments: { lat: 40.7, lon: -74, start: `${day}T00:00:00Z`, end: `${day}T23:00:00Z`, stepSeconds: 60 },
  _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}, "io.modelcontextprotocol/clientInfo": { name: "abort-probe", version: run } } } })

type Case = { name: string; head: string; send: (s: tls.TLSSocket) => void; closeOn: "sent" | "first-bytes" }
const hdr = (method: string, path: string, extra: Record<string, string>) =>
  `${method} ${path} HTTP/1.1\r\nhost: ${base.host}\r\nuser-agent: ephem-abort-probe\r\nx-ephem-smoke: ${run}\r\n` +
  (pin ? `cloudflare-workers-version-overrides: ephem="${pin}"\r\n` : "") +
  Object.entries(extra).map(([k, v]) => `${k}: ${v}\r\n`).join("") + "\r\n"
const fastBody = JSON.stringify({ jsonrpc: "2.0", id: `${run}-2`, method: "tools/call", params: { name: "position", arguments: { lat: 40.7, lon: -74 }, _meta: JSON.parse(body).params._meta } })
const fastHead = hdr("POST", "/mcp", { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "position", "content-length": String(fastBody.length) })
const mcpHead = hdr("POST", "/mcp", { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "track", "content-length": String(body.length) })
const cases: Case[] = [
  { name: "mcp-body", head: mcpHead, send: s => s.write(mcpHead + body.slice(0, body.length >> 1)), closeOn: "sent" },
  { name: "mcp-response", head: mcpHead, send: s => s.write(mcpHead + body), closeOn: "sent" },
  { name: "mcp-fast", head: fastHead, send: s => s.write(fastHead + fastBody), closeOn: "sent" },
  { name: "home-stream", head: "", send: s => s.write(hdr("GET", "/", { accept: "text/html" })), closeOn: "first-bytes" },
  { name: "api-fast", head: "", send: s => s.write(hdr("GET", "/v1/position?lat=40.7&lon=-74", {})), closeOn: "sent" },
  { name: "api-response", head: "", send: s => s.write(hdr("GET", `/v1/track?lat=40.7&lon=-74&start=${day}T00:00:00Z&end=${day}T23:00:00Z&stepSeconds=60`, {})), closeOn: "sent" },
]

const one = (c: Case) => new Promise<string>(resolve => {
  const s = tls.connect({ host: base.hostname, port: 443, servername: base.hostname, ALPNProtocols: ["http/1.1"] }, () => {
    c.send(s)
    // "sent": give the edge time to start the Worker (the request has reached it), then drop the connection without reading
    if (c.closeOn === "sent") setTimeout(() => { s.destroy(); resolve(`${c.name} - closed ${delay} ms after send`) }, delay)
  })
  let buf = ""
  s.on("data", d => {
    buf += d.toString("latin1")
    if (c.closeOn === "first-bytes" && buf.includes("\r\n\r\n")) {
      const ray = /cf-ray: (\S+)/i.exec(buf)?.[1] ?? "-", st = /^HTTP\/1\.1 (\d+)/.exec(buf)?.[1]
      s.destroy(); resolve(`${c.name} ${ray} closed after ${buf.length} bytes (status ${st})`)
    }
  })
  s.on("error", e => resolve(`${c.name} - socket error ${e.message}`))
})

for (const c of cases.filter(c => !only || only.includes(c.name))) console.log(await one(c))
console.log(`run ${run}`)
