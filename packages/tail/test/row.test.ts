import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { ROUTES as TAIL_ROUTES, routeCounts, routeOf, shapeOf, toRow, type InvocationRow } from "../src/row.ts"
import { ROUTES } from "../../worker/src/routes.ts"
import tail from "../src/index.ts"
import type { EphemInvocationsRecord } from "../../worker/src/basin.generated.ts"

/** Compile-time: our row is assignable to the record `wrangler types` generates from the live stream schema. */
const typed = (r: InvocationRow): EphemInvocationsRecord => r

const SCHEMA = JSON.parse(readFileSync(resolve(__dirname, "../../worker/ops/basin/invocations.schema.json"), "utf8")) as Array<{ name: string; type: string; required: boolean }>

const item = (over: Record<string, unknown> = {}) => ({
  scriptName: "ephem", eventTimestamp: Date.parse("2026-10-29T12:00:00Z"), outcome: "exceededCpu", entrypoint: "default",
  scriptVersion: { id: "80f5b087-e41d-4023-bc05-508c7982e31e" }, cpuTime: 51, wallTime: 120,
  event: { request: { url: "https://ephem.ivar.workers.dev/v1/alignment?targetLat=40.1234&token=abc", method: "GET", headers: { "cf-ray": "8d0-EWR", "user-agent": "curl/8" }, cf: { colo: "EWR", clientTcpRtt: 3 } }, response: { status: 500 } },
  logs: [{ level: "error", message: [JSON.stringify({ basin_send_failed: { stream: "ephem_requests" } })] }, { level: "log", message: ["hi"] }],
  exceptions: [{ name: "Error", message: "Worker exceeded CPU time limit." }, { name: "Error", message: "again" }],
  ...over,
})

describe("tail rows", () => {
  it("one row per invocation: outcome, version, route (not path), exceptions, send failures; no query or headers", () => {
    const r = toRow(item())
    expect(r).toEqual({ ts: "2026-10-29T12:00:00.000Z", script_version: "80f5b087-e41d-4023-bc05-508c7982e31e", entrypoint: "default", outcome: "exceededCpu", method: "GET",
      route: "/v1/alignment", status: 500, ray: "8d0-EWR", colo: "EWR", exception_names: "Error", exceptions: 2, error_logs: 1, basin_send_failed: 1, cpu_ms: 51, wall_ms: 120 })
    const json = JSON.stringify(r); for (const leak of ["token", "40.1234", "curl"]) expect(json).not.toContain(leak)
    const byName = new Map(SCHEMA.map(f => [f.name, f]))
    for (const k of Object.keys(r)) expect(byName.has(k), k).toBe(true)
    for (const f of SCHEMA) if (f.required) expect(r).toHaveProperty(f.name)
    expect(typed(r)).toBe(r)
  })
  it("non-fetch and sparse items still make a valid row", () => {
    expect(toRow({ outcome: "ok", event: null }, 0)).toEqual({ ts: "1970-01-01T00:00:00.000Z", outcome: "ok", exceptions: 0, error_logs: 0, basin_send_failed: 0 })
    expect(routeOf("https://x/secret/path")).toBe("other"); expect(routeOf("not a url")).toBe("other"); expect(routeOf("https://x/")).toBe("/")
  })
  it("labels every ephem route from ephem's own list (packages/worker/src/routes.ts)", () => {
    expect(TAIL_ROUTES).toBe(ROUTES)
    for (const p of ["/v1/track", "/v1/sightline", "/v1/alignment/search", "/internal/alignment-search-window", "/llms.txt", "/docs/interactive"])
      expect(routeOf(`https://ephem.ivar.workers.dev${p}?lat=1`), p).toBe(p)
    for (const p of ROUTES) expect(routeOf(`http://api.internal${p}`), p).toBe(p)
    expect(routeOf("https://x/block/abc/3")).toBe("other")
    expect(routeCounts([toRow(item()), toRow(item()), toRow(item({ entrypoint: "Api" }))])).toEqual(["default /v1/alignment 2", "Api /v1/alignment 1"])
    expect(routeCounts([toRow(item({ entrypoint: undefined, event: { request: { url: "https://x/llms.txt" } } }))])).toEqual(["- /llms.txt 1"])
  })
  it("labels another script's entrypoint <script>/<entrypoint> (ephem-compute), ephem's own unchanged", () => {
    expect(toRow(item({ scriptName: "ephem-compute", entrypoint: "Api" })).entrypoint).toBe("ephem-compute/Api")
    expect(toRow(item({ scriptName: "ephem-compute", entrypoint: undefined })).entrypoint).toBe("ephem-compute/-")
    expect(toRow(item({ scriptName: "ephem", entrypoint: "MetarFeed" })).entrypoint).toBe("MetarFeed")
    expect(routeCounts([toRow(item({ scriptName: "ephem-compute", entrypoint: "Api", event: { request: { url: "https://api.internal/internal/alignment-search-window?x=1" } } }))])).toEqual(["ephem-compute/Api /internal/alignment-search-window 1"])
  })
  it("shapeOf reports key names only", () => {
    const s = shapeOf(item()); expect(s.item).toContain("outcome"); expect(JSON.stringify(s)).not.toContain("ephem.ivar.workers.dev")
  })
  it("sends one batch per tail call from waitUntil; a rejecting send logs basin_send_failed and does not throw", async () => {
    const waits: Promise<unknown>[] = [], sent: unknown[][] = [], errs: string[] = []
    const logs: string[] = []
    const orig = console.error, origLog = console.log; console.error = (m: string) => { errs.push(m) }; console.log = (m: string) => { logs.push(m) }
    try {
      await tail.tail([item(), item({ outcome: "ok" })], { INVOCATIONS: { send: async rs => { sent.push([...rs]) } } }, { waitUntil: p => { waits.push(p) } })
      await tail.tail([item()], { INVOCATIONS: { send: async () => { throw new Error("down") } } }, { waitUntil: p => { waits.push(p) } })
      await Promise.all(waits)
    } finally { console.error = orig; console.log = origLog }
    expect(sent).toHaveLength(1); expect(sent[0]).toHaveLength(2)
    expect(logs.map(l => JSON.parse(l)).filter(l => l.tail_batch).map(l => l.tail_batch)).toEqual([{ rows: 2, routes: ["default /v1/alignment 2"] }, { rows: 1, routes: ["default /v1/alignment 1"] }])
    expect(errs).toHaveLength(1); expect(JSON.parse(errs[0]!).basin_send_failed).toMatchObject({ stream: "ephem_invocations", rows: 1 })
  })
})
