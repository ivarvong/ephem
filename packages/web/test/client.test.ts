// The browser modules' pure parts and their behaviour under stubbed browser globals: the page's trace context, RUM's off
// switches, the clock offset, block arithmetic and the parity check.
import { afterEach, describe, expect, it, vi } from "vitest"
import { readTrace } from "../src/client/trace.ts"
import { blockOf, blocksFor, clockOffset, nextDate, trackQuery } from "../src/lib/time.ts"
import { diffDay, diffPos, parityOk } from "../src/lib/parity.ts"
import { halfPx, scrubOffset, tlTime, tlX, TL_PAD } from "../src/lib/timeline.ts"
import type { Position } from "../src/lib/types.ts"

const TID = "4bf92f3577b34da6a3ce929d0e0e4736",
  SID = "00f067aa0ba902b7",
  TP = `00-${TID}-${SID}-01`
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe("trace context", () => {
  it("the page reads the meta tag first, then the navigation entry's serverTiming, then mints a fresh id", () => {
    const OTHER = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`,
      st = (d: string) => [
        { name: "total", description: "" },
        { name: "trace", description: d },
      ]
    expect(readTrace(TP, st(OTHER))).toMatchObject({ traceId: TID, parentSpanId: SID, from: "meta" })
    expect(readTrace(null, st(OTHER))).toMatchObject({
      traceId: "a".repeat(32),
      parentSpanId: "b".repeat(16),
      from: "server-timing",
    })
    expect(readTrace("junk", [])).toMatchObject({ parentSpanId: null, from: "fresh" })
    expect(readTrace(`00-${"0".repeat(32)}-${SID}-01`, []).from).toBe("fresh")
    expect(readTrace(null, []).traceId).toMatch(/^[0-9a-f]{32}$/)
  })
  it("one trace id per page view, a fresh span id per fetch, every fetch recorded (window.__ephemTrace)", async () => {
    const seen: Headers[] = [],
      win: Record<string, unknown> = {}
    vi.stubGlobal("window", win)
    vi.stubGlobal("document", { querySelector: () => ({ getAttribute: () => TP }) })
    vi.stubGlobal("fetch", async (_u: string, i: RequestInit) => {
      seen.push(new Headers(i.headers))
      return new Response("{}", { headers: { "cf-ray": "abc-EWR", "x-ephem-trace": TID } })
    })
    const { tfetch } = await import("../src/client/trace.ts")
    await tfetch("/a")
    await tfetch("/b")
    const ids = seen.map((h) => /^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/.exec(h.get("traceparent") ?? "")!)
    expect(ids[0]![1]).toBe(TID)
    expect(ids[1]![1]).toBe(TID)
    expect(ids[0]![2]).not.toBe(ids[1]![2])
    expect(seen[0]!.get("tracestate")).toBe("ephem=" + SID)
    const T = win["__ephemTrace"] as { fetches: Array<{ ray: string; status: number }> }
    expect(T.fetches.map((f) => [f.ray, f.status])).toEqual([
      ["abc-EWR", 200],
      ["abc-EWR", 200],
    ])
  })
})

describe("RUM", () => {
  const boot = async (nav: Record<string, unknown>, meta: string | null) => {
    const win: Record<string, unknown> = { PerformanceObserver: function () {} }
    vi.stubGlobal("window", win)
    vi.stubGlobal("navigator", nav)
    vi.stubGlobal("document", {
      querySelector: (s: string) => (s.includes("traceparent") && meta != null ? { getAttribute: () => meta } : null),
    })
    const { startRum } = await import("../src/client/rum.ts")
    return startRum().off
  }
  it("is off under DNT and GPC, and for an unsampled traceparent", async () => {
    expect(await boot({ doNotTrack: "1" }, TP)).toBe("privacy")
    vi.resetModules()
    expect(await boot({ globalPrivacyControl: true }, TP)).toBe("privacy")
    vi.resetModules()
    expect(await boot({}, `00-${TID}-${SID}-00`)).toBe("unsampled")
  })
})

describe("time", () => {
  it("the clock offset is the midpoint of the head's arrival window, ± half its width", () => {
    expect(clockOffset(10_000, { requestStart: 100, responseStart: 300 }, 1000, 5000)).toEqual({
      off: 10_000 - 1200,
      pm: 100,
      nt: true,
    })
    expect(clockOffset(10_000, null, 1000, 5000)).toEqual({ off: 5000, pm: 0, nt: false })
  })
  it("the track window: [D − 24 h, D + 48 h] on the UTC grid, the same all UTC day", () => {
    const a = trackQuery(40.7, -74, Date.parse("2026-10-31T00:00:01Z")),
      b = trackQuery(40.7, -74, Date.parse("2026-10-31T23:59:59Z"))
    expect(a).toEqual(b)
    expect(a).toEqual({ lat: "40.70000", lon: "-74.00000", start: "2026-10-30T00:00:00Z", end: "2026-11-02T00:00:00Z" })
    expect(nextDate("2026-12-31")).toBe("2027-01-01")
  })
  it("DE440 blocks: 32 days each from JD 2287184.5, with a margin for TDB and light time", () => {
    const t = Date.parse("2026-10-31T00:00:00Z")
    expect(blocksFor(t, t)).toContain(blockOf(t))
    expect(blocksFor(t - 864e5 * 40, t).length).toBeGreaterThanOrEqual(2)
  })
})

describe("parity", () => {
  const b = { azimuth: 10, altitude: 5, apparentAltitude: 5.1, declination: 1, distanceKm: 1e5, rightAscension: 23.99 }
  const p: Position = {
    time: { utc: "2026-10-31T00:00:00.000Z" },
    sun: b,
    moon: { ...b, phase: { name: "full", illuminatedFraction: 1, brightLimbAngle: 359.9999 } },
  }
  it("angles wrap, RA is in hours, km apart; null vs a number is a mismatch", () => {
    const q: Position = {
      ...p,
      sun: { ...b, rightAscension: 0.00001 },
      moon: { ...p.moon, phase: { ...p.moon.phase, brightLimbAngle: 0.0001 } },
    }
    const d = diffPos(p, q)
    expect(d.deg).toBeCloseTo((24 - 23.99 + 0.00001) * 15, 6) // 23.99 h vs 0.00001 h: 0.15°, not 359.85°
    expect(diffPos(p, { ...p, sun: { ...b, apparentAltitude: null } }).bad).toEqual(["sun.apparentAltitude"])
    expect(parityOk({ pos: diffPos(p, p) })).toBe(true)
    expect(parityOk({ pos: d })).toBe(false)
  })
  it("days: the same events in order, times within 1 ms", () => {
    const d = {
      date: "2026-10-31",
      start: "",
      end: "",
      events: [{ body: "sun" as const, kind: "rise", time: "2026-10-31T11:00:00.000Z" }],
    }
    expect(diffDay(d, { ...d, events: [{ ...d.events[0]!, time: "2026-10-31T11:00:00.001Z" }] })).toEqual({
      ms: 1,
      n: 1,
      bad: [],
    })
    expect(diffDay(d, { ...d, events: [] }).bad).toEqual(["events 1 vs 0"])
  })
})

describe("scrub math", () => {
  const s0 = Date.parse("2026-10-31T12:00:00Z"),
    span = 24 * 3600e3,
    w = 358
  it("x and time are inverse inside the line, clamped outside it; the window's end is exclusive", () => {
    for (const t of [s0, s0 + 3 * 3600e3, s0 + span / 2])
      expect(tlTime(s0, span, w, tlX(s0, span, w, t))).toBeCloseTo(t, -2)
    expect(tlX(s0, span, w, s0 - 1e9)).toBe(TL_PAD)
    expect(tlX(s0, span, w, s0 + 2 * span)).toBe(w - TL_PAD)
    expect(tlTime(s0, span, w, -50)).toBe(s0)
    expect(tlTime(s0, span, w, w + 50)).toBe(s0 + span - 1)
  })
  it("a scrub never leaves the window; markers move on a half-pixel grid", () => {
    const base = s0 + 3 * 3600e3
    expect(scrubOffset(s0, span, base + 3600e3, base)).toBe(3600e3)
    expect(scrubOffset(s0, span, s0 - 1e9, base)).toBe(s0 - base)
    expect(scrubOffset(s0, span, s0 + 9e9, base)).toBe(s0 + span - 1 - base)
    expect(halfPx(10.24)).toBe(10)
    expect(halfPx(10.26)).toBe(10.5)
  })
})
