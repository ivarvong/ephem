// The telemetry gate's rules (scripts/obs/gate_rules.py, run by canary-gate.py in deploy.sh) on events recorded from prod
// (fixtures/gate/, written by scripts/obs/gate-fixture.py): a client that disconnects is counted, never a failure; a server
// error always fails. ac16823e was rolled back by the first kind (2026-10-31): the fixture is that rollback's own events.
import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const ROOT = resolve(__dirname, "../../..")
const FIX = resolve(__dirname, "fixtures/gate")
type Verdict = { errors: Array<[string, string]>; aborts: Array<[string, string]> }
type Ev = {
  $metadata: Record<string, unknown>
  $workers?: { outcome?: string; event?: { response?: { status?: number } } }
  source?: Record<string, unknown>
}
const load = (name: string) => (JSON.parse(readFileSync(`${FIX}/${name}`, "utf8")) as { events: Ev[] }).events

/** classify() on these events, in Python (the gate's own code). */
const classify = (events: Ev[], final = true): Verdict =>
  JSON.parse(
    execFileSync(
      "python3",
      [
        "-I",
        "-c",
        `
import json, sys
sys.path.insert(0, ${JSON.stringify(resolve(ROOT, "scripts/obs"))})
from gate_rules import classify
errs, aborts = classify(json.load(sys.stdin), final=${final ? "True" : "False"})
print(json.dumps({"errors": [[k, m] for _, k, m in errs], "aborts": [[k, m] for _, k, m in aborts]}))
`,
      ],
      { input: JSON.stringify(events) },
    ).toString(),
  ) as Verdict

describe("canary gate: client aborts pass, server errors fail", () => {
  it("the crashed mcp-probe that rolled back ac16823e: 4 runtime 'Network connection lost.' logs + 1 canceled, all client aborts", () => {
    const v = classify(load("abort-mcp-ac16823e.json"))
    expect(v.errors).toEqual([])
    expect(v.aborts.filter((a) => a[0] === "disconnect")).toHaveLength(4)
    expect(v.aborts.filter((a) => a[0] === "outcome canceled").length).toBeGreaterThanOrEqual(1)
  })
  it("abort-probe on prod: streamed / closed after the head, /v1/track closed before the answer", () => {
    const v = classify(load("abort-home-7c99bb80.json"))
    expect(v.errors).toEqual([])
    expect(v.aborts.map((a) => a[0]).toSorted()).toEqual(["disconnect", "outcome canceled", "outcome canceled"]) // invocation + root span of /v1/track
  })
  it("abort-probe on prod: /mcp tools/call and /v1/position closed right after sending (the answer existed, the client did not)", () => {
    const v = classify(load("abort-mcp-position-7c99bb80.json"))
    expect(v.errors).toEqual([])
    expect(v.aborts.filter((a) => a[0] === "disconnect")).toHaveLength(4)
  })
  it("a thrown error fails: outcome exception, 500, the error log", () => {
    const v = classify(load("server-throw.json"))
    expect(v.aborts).toEqual([])
    expect(v.errors.map((e) => e[0])).toEqual(expect.arrayContaining(["outcome exception", "status 500", "log error"]))
  })
  it("a response stream that errors server-side after the headers fails (no status, so only the outcome and the log say so)", () => {
    const v = classify(load("server-stream-throw.json"))
    expect(v.aborts).toEqual([])
    expect(v.errors.map((e) => e[0])).toEqual(expect.arrayContaining(["outcome exception", "log error"]))
  })
  it("'Network connection lost.' on a request that also returned a 5xx is a server error, not an abort", () => {
    const evs = load("abort-home-7c99bb80.json").map((e) =>
      e.$metadata.type === "cf-worker-event"
        ? { ...e, $workers: { ...e.$workers, event: { ...e.$workers?.event, response: { status: 502 } } } }
        : e,
    )
    const v = classify(evs)
    expect(v.errors.map((e) => e[0])).toEqual(expect.arrayContaining(["status 502", "log error"]))
  })
  it("a disconnect log without its invocation: not judged while ingest is incomplete, an error at the deadline (fail closed)", () => {
    const evs = load("abort-mcp-ac16823e.json").filter((e) => e.$metadata.type !== "cf-worker-event")
    expect(classify(evs, false).errors).toEqual([])
    expect(classify(evs, true).errors.filter((e) => e[0] === "log error")).toHaveLength(4)
  })
  it("the front door's own client_aborted record (info) is counted, never an error", () => {
    const rec: Ev = {
      $metadata: { type: "cf-worker", rayId: "a5300000000000aa", id: "x", level: "info" },
      source: { evt: "client_aborted", phase: "body", route: "/" },
    }
    const v = classify([rec])
    expect(v).toEqual({ errors: [], aborts: [["client_aborted", expect.stringContaining("body")]] })
  })
})
