// src/abort.ts: the front door pumps the body itself, so a client that leaves is recorded as an abort (info log, span
// client.aborted=true, row error_tag ClientAbort) and a body that fails on our side is still a server error (console.error).
import { afterEach, describe, expect, it, vi } from "vitest"
import { afterDelivery, deliver } from "../src/abort.ts"
import type { Tracing } from "../src/trace.ts"

const spans: Array<{ name: string; attrs: Record<string, unknown> }> = []
const tracing: Tracing = { startSpan: name => { const s = { name, attrs: {} as Record<string, unknown> }; spans.push(s); return { isTraced: true, setAttribute: (k, v) => { s.attrs[k] = v }, setStatus: () => {}, end: () => {} } } }
const pending: Array<Promise<unknown>> = []
const wu = (p: Promise<unknown>) => { pending.push(p) }
afterEach(() => { spans.length = 0; pending.length = 0; vi.restoreAllMocks() })
const enc = new TextEncoder()
const chunks = (n: number, fail?: Error) => { let i = 0; return new ReadableStream<Uint8Array>({ pull(c) { if (i === n) return fail ? c.error(fail) : c.close(); c.enqueue(enc.encode(`chunk${i++};`)) } }) }

describe("deliver", () => {
  it("delivers the body unchanged, with status and headers; not an abort", async () => {
    const d = await deliver(new Response(chunks(3), { status: 201, headers: { "x-a": "1" } }), wu, "/", tracing)
    expect(d.response.status).toBe(201); expect(d.response.headers.get("x-a")).toBe("1")
    expect(await d.response.text()).toBe("chunk0;chunk1;chunk2;")
    expect(await d.aborted).toBe(false); expect(spans).toEqual([])
  })
  it("a client that leaves mid-body: client_aborted at info, span client.aborted=true / ephem.outcome=canceled, no error", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {}), err = vi.spyOn(console, "error").mockImplementation(() => {})
    const d = await deliver(new Response(chunks(1000)), wu, "/", tracing)
    const r = d.response.body!.getReader(); await r.read(); await r.cancel(new Error("Network connection lost."))
    expect(await d.aborted).toBe(true)
    expect(err).not.toHaveBeenCalled()
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ evt: "client_aborted", phase: "body", route: "/", error: "Error: Network connection lost." })
    expect(spans).toEqual([{ name: "client.abort", attrs: expect.objectContaining({ "client.aborted": true, "ephem.outcome": "canceled", "client.abort_phase": "body", "http.route": "/" }) }])
  })
  it("our own body failing is a server error: response_stream_failed at error level, not an abort", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    const d = await deliver(new Response(chunks(1, new Error("boom"))), wu, "/", tracing)
    await expect(d.response.text()).rejects.toThrow()
    expect(await d.aborted).toBe(false)
    expect(JSON.parse(err.mock.calls[0]![0] as string)).toMatchObject({ response_stream_failed: { route: "/", error: "Error: boom" } })
    expect(spans).toEqual([])
  })
  it("a known-length body keeps its bytes and Content-Length; a failed read of it is a server error (rethrown)", async () => {
    const d = await deliver(new Response("{\"a\":1}", { headers: { "content-length": "7", "content-type": "application/json" } }), wu, "/day", tracing)
    expect(d.response.headers.get("content-length")).toBe("7"); expect(await d.response.text()).toBe('{"a":1}'); expect(await d.aborted).toBe(false)
    const err = vi.spyOn(console, "error").mockImplementation(() => {})
    await expect(deliver(new Response(chunks(1, new Error("boom")), { headers: { "content-length": "99" } }), wu, "/day", tracing)).rejects.toThrow("boom")
    expect(JSON.parse(err.mock.calls[0]![0] as string)).toMatchObject({ response_stream_failed: { route: "/day" } })
  })
  it("no body: returned as is", async () => {
    const res = new Response(null, { status: 204 }), d = await deliver(res, wu, undefined, tracing)
    expect(d.response).toBe(res); expect(await d.aborted).toBe(false)
  })
})

describe("afterDelivery", () => {
  it("emits the row after delivery; error_tag ClientAbort when the client left", async () => {
    const rows: Array<{ error_tag?: string; n: number }> = []
    const a = afterDelivery<{ error_tag?: string; n: number }>(r => rows.push(r), wu), b = afterDelivery<{ error_tag?: string; n: number }>(r => rows.push(r), wu)
    a.emit({ n: 1 }); b.emit({ n: 2 })
    expect(rows).toEqual([])
    a.settle(Promise.resolve(false)); b.settle(Promise.resolve(true))
    await Promise.all(pending)
    expect(rows.toSorted((x, y) => x.n - y.n)).toEqual([{ n: 1 }, { n: 2, error_tag: "ClientAbort" }])
  })
})
