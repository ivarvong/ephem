#!/usr/bin/env node
/** Zero-dependency MCP-over-HTTP client for Node.js 24+. */
const endpointDefault = "https://ephem.ivar.workers.dev/mcp"
const protocolVersion = "2025-03-26"

function parseArgs(argv) {
  const opts = { endpoint: process.env.EPHEM_MCP_URL ?? endpointDefault }
  const args = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--endpoint") opts.endpoint = argv[++i]
    else if (argv[i] === "--out") opts.out = argv[++i]
    else args.push(argv[i])
  }
  return { opts, args }
}

function parseSse(text) {
  const messages = []
  for (const block of text.replaceAll("\r\n", "\n").split("\n\n")) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
    if (data && data !== "[DONE]") messages.push(JSON.parse(data))
  }
  if (!messages.length) throw new Error("SSE response contained no JSON data event")
  return messages.length === 1 ? messages[0] : messages
}

async function post(endpoint, body) {
  const startedAt = new Date().toISOString()
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { accept: "application/json,text/event-stream", "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  const contentType = response.headers.get("content-type") ?? ""
  let raw
  try {
    raw = contentType.includes("text/event-stream") ? parseSse(text) : JSON.parse(text)
  } catch (cause) {
    throw new Error(`Could not parse ${contentType || "unknown"} response (HTTP ${response.status}): ${cause.message}`)
  }
  const headers = Object.fromEntries(response.headers.entries())
  const envelope = {
    endpoint,
    startedAt,
    request: body,
    http: { status: response.status, ok: response.ok, headers },
    provenance: {
      protocolVersion,
      ephemVersion: response.headers.get("x-ephem-version"),
      ephemTrace: response.headers.get("x-ephem-trace"),
      ephemCache: response.headers.get("x-ephem-cache"),
    },
    raw,
  }
  if (!response.ok) throw Object.assign(new Error(`MCP HTTP ${response.status}`), { envelope })
  const messages = Array.isArray(raw) ? raw : [raw]
  const rpcError = messages.find((message) => message?.error)?.error
  if (rpcError) throw Object.assign(new Error(`MCP JSON-RPC error ${rpcError.code}: ${rpcError.message}`), { envelope })
  return envelope
}

export async function mcpInitialize(endpoint = endpointDefault) {
  return post(endpoint, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion, capabilities: {}, clientInfo: { name: "ephem-skill", version: "1.0.0" } },
  })
}
export async function mcpListTools(endpoint = endpointDefault) {
  return post(endpoint, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
}
export async function mcpCallTool(name, arguments_, endpoint = endpointDefault, id = 3) {
  const envelope = await post(endpoint, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: arguments_ },
  })
  const message = Array.isArray(envelope.raw) ? envelope.raw.at(-1) : envelope.raw
  envelope.isError = message?.result?.isError === true
  envelope.result = message?.result ?? null
  if (envelope.isError) throw Object.assign(new Error(`MCP tool ${name} returned isError`), { envelope })
  return envelope
}

async function main() {
  const { opts, args } = parseArgs(process.argv.slice(2))
  const [command, ...rest] = args
  let envelope
  if (command === "initialize") envelope = await mcpInitialize(opts.endpoint)
  else if (command === "tools/list") envelope = await mcpListTools(opts.endpoint)
  else if (command === "tools/call") {
    if (!rest[0] || !rest[1]) throw new Error("Usage: mcp.mjs tools/call NAME JSON [--out FILE]")
    envelope = await mcpCallTool(rest[0], JSON.parse(rest.slice(1).join(" ")), opts.endpoint)
  } else throw new Error("Usage: mcp.mjs initialize|tools/list|tools/call NAME JSON [--endpoint URL] [--out FILE]")
  const output = `${JSON.stringify(envelope, null, 2)}\n`
  if (opts.out) await (await import("node:fs/promises")).writeFile(opts.out, output)
  else process.stdout.write(output)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(async (error) => {
    if (error.envelope) process.stderr.write(`${JSON.stringify(error.envelope, null, 2)}\n`)
    console.error(error.message)
    process.exitCode = 1
  })
}
