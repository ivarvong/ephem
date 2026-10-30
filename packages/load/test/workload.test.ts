import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { add, hist, kindStats, mergeHist, quantile, record } from "../src/stats.ts"
import { KINDS, LIMITS, MIXED, ORIGIN, WARM_KEYS, build, endOf, keyRand, measureFrom, headers, mulberry32, picker, plan, rayColo, searchRate, target, validate } from "../src/workload.ts"
import park from "../src/park.json" with { type: "json" }

const NOW = Date.parse("2026-10-30T12:00:00Z")
const ok = (b: Record<string, unknown>) => {
  const v = validate(b, NOW, () => 0.5)
  if (!v.ok) throw new Error(v.reason)
  return v.spec
}
const refused = (b: unknown) => { const v = validate(b, NOW, () => 0.5); return v.ok ? null : v.reason }

describe("limits (the Worker refuses anything outside them)", () => {
  it("accepts the validation run", () => {
    const s = ok({ mode: "mixed", rate: 60, duration: 60, regions: ["enam", "weur", "apac"] })
    expect(s).toMatchObject({ mode: "mixed", rate: 60, durationS: 60, warmupS: LIMITS.defaultWarmupS, seed: 1, pin: null, startAt: NOW + LIMITS.startLeadMs })
    expect(endOf(s) - measureFrom(s)).toBe(60_000); expect(measureFrom(s) - s.startAt).toBe(LIMITS.defaultWarmupS * 1000)
    expect(refused({ mode: "position", rate: 1, duration: 1, regions: ["enam"], warmup: LIMITS.maxWarmupS + 1 })).toMatch(/warmup/)
    expect(refused({ mode: "position", rate: 250, duration: 230, warmup: 20, regions: ["enam", "wnam", "weur", "apac"] })).toMatch(/warmup \+ duration/)
    expect(s.runId).toMatch(/^L20261030T120000Z-/)
  })
  it("refuses any field that could aim it elsewhere", () => {
    for (const f of ["target", "origin", "host", "url", "path", "headers"]) expect(refused({ mode: "position", rate: 1, duration: 1, regions: ["enam"], [f]: "https://example.com" })).toMatch(/unknown field/)
  })
  it("caps rate, duration, requests per run, scans, regions", () => {
    expect(refused({ mode: "position", rate: LIMITS.maxRate + 1, duration: 10, regions: ["enam", "wnam", "weur", "apac", "oc"] })).toMatch(/over the cap/)
    expect(refused({ mode: "position", rate: 1, duration: LIMITS.maxDurationS + 1, regions: ["enam"] })).toMatch(/over the cap/)
    expect(refused({ mode: "position", rate: 200, duration: 400, regions: ["enam", "wnam", "weur", "apac"] })).toMatch(/per-run cap/)
    expect(refused({ mode: "search", rate: 120, duration: 240, regions: ["enam"] })).toMatch(/scan rate/)
    expect(ok({ mode: "search", rate: 2, duration: 240, regions: ["enam", "weur", "apac"] }).rate).toBe(2)   // 120/min
    expect(refused({ mode: "mixed", rate: 300, duration: 60, regions: ["enam"], mix: { search: 10, position: 90 } })).toMatch(/scan rate/)
    expect(refused({ mode: "position", rate: 1, duration: 1, regions: ["enam", "wnam", "weur", "eeur", "apac", "oc"] })).toMatch(/at most/)
    expect(refused({ mode: "position", rate: 1, duration: 1, regions: ["mars"] })).toMatch(/not one of/)
    expect(refused({ mode: "position", rate: 1, duration: 1.5, regions: ["enam"] })).toMatch(/integer/)
    expect(refused({ mode: "position", rate: -1, duration: 1, regions: ["enam"] })).toMatch(/positive/)
  })
  it("pins only a full version id", () => {
    expect(ok({ mode: "position", rate: 1, duration: 1, regions: ["enam"], pin: "21250fb5-0000-4000-8000-000000000000" }).pin).toBe("21250fb5-0000-4000-8000-000000000000")
    expect(refused({ mode: "position", rate: 1, duration: 1, regions: ["enam"], pin: 'x" , other="y' })).toMatch(/uuid/)
  })
  it("every built URL is on ephem; nothing else is", () => {
    const rand = mulberry32(7)
    for (let i = 0; i < 500; i++) for (const k of KINDS) expect(target(build(k, rand, i, NOW).path).origin).toBe(ORIGIN)
    for (const p of ["//evil.example/x", "https://evil.example/", "evil", "/\\evil.example"]) {
      let u: URL | null = null
      try { u = target(p) } catch { /* refused */ }
      if (u) expect(u.origin).toBe(ORIGIN)
    }
  })
})

describe("plan", () => {
  it("splits the rate evenly over regions and shards, under one invocation's ceiling", () => {
    const s = ok({ mode: "mixed", rate: 180, duration: 60, regions: ["enam", "weur", "apac"] })
    const p = plan(s)
    expect(new Set(p.map(x => x.region))).toEqual(new Set(["enam", "weur", "apac"]))
    expect(p.length).toBe(3 * 15)
    expect(p.reduce((a, x) => a + x.rate, 0)).toBeCloseTo(180)
    expect(plan(ok({ mode: "position", rate: 8, duration: 60, regions: ["enam"], shards: 8 }))).toHaveLength(8)   // more shards on request
    expect(plan(ok({ mode: "position", rate: 40, duration: 60, regions: ["enam"], shards: 1 }))).toHaveLength(10)  // never fewer than needed
    expect(refused({ mode: "position", rate: 65, duration: 60, regions: ["enam"] })).toMatch(/per region/)
    expect(refused({ mode: "position", rate: 1, duration: 60, regions: ["enam"], shards: 17 })).toMatch(/shards/)
    for (const x of p) expect(x.rate).toBeLessThanOrEqual(LIMITS.shardRate)
    expect(new Set(p.map(x => x.seed)).size).toBe(p.length)
  })
  it("gives scans enough shards for their latency", () => {
    const p = plan(ok({ mode: "search", rate: 4, duration: 60, regions: ["enam"] }))
    expect(p.length).toBe(Math.ceil(4 / LIMITS.shardSearchRate))
    expect(searchRate(ok({ mode: "mixed", rate: 100, duration: 60, regions: ["enam", "weur"] }))).toBeCloseTo(1)
  })
})

describe("workloads", () => {
  it("match the laptop harnesses", () => {
    const r = mulberry32(1)
    expect(build("position", r, 0, NOW).path).toBe("/v1/position?lat=40.7&lon=-74")
    expect(WARM_KEYS).toHaveLength(24)
    expect(build("warm", r, 25, NOW).path).toBe(WARM_KEYS[1])
    const t = new URL(build("track", r, 0, NOW).path, ORIGIN)
    expect(Date.parse(t.searchParams.get("end")!) - Date.parse(t.searchParams.get("start")!)).toBe(3 * 86_400_000)
    expect(Date.parse(t.searchParams.get("start")!) % 86_400_000).toBe(0)
    const w = new URL(build("weather", r, 0, NOW).path, ORIGIN)
    expect(Number(w.searchParams.get("n"))).toBeGreaterThanOrEqual(1)
    const s = build("search", r, 0, NOW)
    expect(s.method).toBe("POST")
    const body = JSON.parse(s.body!)
    expect(body.target.height).toBeGreaterThanOrEqual(71)
    expect(body.region).toEqual(JSON.parse(readFileSync(new URL("../../../scripts/obs/split-ab/brooklyn-bridge-park.geojson", import.meta.url), "utf8")))
    expect(park.type).toBe("Feature")
  })
  it("cold keys never repeat across runs, even with the same seed and plan", () => {
    const a = keyRand("L20261030T224511Z-iqf9", 7), b = keyRand("L20261030T224512Z-abcd", 7)
    const pa = new Set(Array.from({ length: 300 }, (_, i) => build("track", a, i, NOW).path)), pb = Array.from({ length: 300 }, (_, i) => build("track", b, i, NOW).path)
    expect(pb.filter(p => pa.has(p))).toHaveLength(0)
    expect(build("track", keyRand("r", 7), 0, NOW).path).toBe(build("track", keyRand("r", 7), 0, NOW).path)   // reproducible per run
  })
  it("fresh keys are fresh", () => {
    const r = mulberry32(3)
    const paths = Array.from({ length: 200 }, (_, i) => build("track", r, i, NOW).path)
    expect(new Set(paths).size).toBe(200)
  })
  it("tags every request with the run, and pins when asked", () => {
    const b = build("position", mulberry32(1), 0, NOW)
    expect(headers({ runId: "r1", pin: null }, b)).toEqual({ "x-ephem-load": "r1", "user-agent": "ephem-load/1 (run r1)" })
    expect(headers({ runId: "r1", pin: "abc" }, b)["cloudflare-workers-version-overrides"]).toBe('ephem="abc"')
  })
  it("mixed weights hold", () => {
    const pick = picker(MIXED), r = mulberry32(9), n: Record<string, number> = {}
    for (let i = 0; i < 100_000; i++) { const k = pick(r()); n[k] = (n[k] ?? 0) + 1 }
    for (const [k, w] of Object.entries(MIXED)) expect(n[k]! / 100_000).toBeCloseTo(w / 100, 2)
  })
  it("reads the answering colo from cf-ray", () => {
    expect(rayColo("8d1f2e3a4b5c6d7e-EWR")).toBe("EWR"); expect(rayColo(null)).toBe("?"); expect(rayColo("abc")).toBe("?")
  })
})

describe("stats", () => {
  it("quantiles within 1 % and merge exactly", () => {
    const a = hist(), b = hist(), all = hist(), xs: number[] = []
    const r = mulberry32(5)
    for (let i = 0; i < 5000; i++) { const x = 5 + 2000 * r() ** 3; xs.push(x); add(i % 2 ? a : b, x); add(all, x) }
    mergeHist(a, b)
    expect(a.counts).toEqual(all.counts); expect(a.n).toBe(all.n); expect(a.max).toBe(all.max); expect(a.sum).toBeCloseTo(all.sum, 6)
    xs.sort((x, y) => x - y)
    for (const q of [0.5, 0.9, 0.99]) {
      const exact = xs[Math.ceil(q * xs.length) - 1]!
      expect(Math.abs(quantile(a, q)! - exact) / exact).toBeLessThan(0.011)
    }
  })
  it("records errors apart from latency, and pin misses", () => {
    const s = kindStats()
    record(s, { status: 200, ms: 12, at: 0, ray: "x-EWR", colo: "EWR", cache: "HIT", version: "v1" }, "v1")
    record(s, { status: 200, ms: 14, at: 5, ray: "y-EWR", colo: "EWR", cache: "HIT", version: "v2" }, "v1")
    record(s, { status: 0, ms: 10_000, at: 9, ray: null, colo: "?", cache: null, version: null, error: "timeout" }, "v1")
    expect(s).toMatchObject({ completed: 3, ok: 2, pinMiss: 1, errors: { timeout: 1 }, served: { EWR: 2 } })
    expect(s.hist.n).toBe(2)
  })
})
