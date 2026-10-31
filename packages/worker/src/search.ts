// /alignment/search. POST (front door): validate, canonicalise the region, fan out one GET per 30-day window on the fixed
// grid, merge, filter. GET /internal/alignment-search-window (Api entrypoint, immutable in Workers Caching): one window computed.
//
// Why fan out instead of caching the POST (Workers Caching stores GET/HEAD only): a rolling "next 12 months" scan never
// repeats exactly, but on the 30-day grid two scans a day apart share 12 of 13 windows; each window is one bounded
// computation in its own invocation (in parallel, at the tier colo), so a scan's wall time is its slowest window and the
// front door does no astronomy at all. Filters and include run after the cache, so they never split it.
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { EphemApi, Unavailable, InvalidRequest, type SearchPayload, type SearchWindowResponse } from "@ephem/api"
import { SEARCH, SUPPORTED, parseInclude, WINDOW_MS, blocksFor, decodeRegion, encodeRegion, isoMs, parseRegion, searchLatRange, searchWindowRequest, windowReadRange, windowsFor } from "@ephem/core"
import { PROV, compute, geoidAcross, jd, parseUtc } from "./handlers.ts"
import { Edge, canonical, forwardHeaders } from "./responses.ts"

import { SEARCH_WINDOW_PATH } from "./routes.ts"
export { SEARCH_WINDOW_PATH }
export const MAX_PASSES = 1000

interface WindowQuery {
  readonly body: "sun" | "moon"; readonly targetLat: number; readonly targetLon: number; readonly targetHeight: number; readonly targetHeightRef?: "ellipsoid" | "msl" | undefined
  readonly height?: number | undefined; readonly heightRef?: "ellipsoid" | "msl" | undefined
  readonly region: string; readonly start: string
  readonly temperature?: number | undefined; readonly pressure?: number | undefined; readonly dut1?: number | undefined
  readonly aim?: "center" | "upper" | "lower" | "litCentroid" | undefined
}

/** One window: the GET handler's body, also run in-process by the POST when there is no front door (tests, dev). */
const windowAnswer = (q: WindowQuery) => Effect.gen(function* () {
  const start = yield* parseUtc(q.start, "start")
  if (start % WINDOW_MS !== 0) return yield* new InvalidRequest({ message: `start must be on the ${SEARCH.windowDays}-day window grid (a multiple of ${SEARCH.windowDays} days since 1970-01-01T00:00Z); this instant's window starts ${isoMs(Math.floor(start / WINDOW_MS) * WINDOW_MS)}` })
  const { fromMs, toMs } = windowReadRange(start)
  if (fromMs < SUPPORTED.fromMs || toMs >= SUPPORTED.toMs) return yield* new InvalidRequest({ message: "the window is outside 1972-01-01 … 2149-12-31 UTC" })
  const reg = decodeRegion(q.region)
  if ("error" in reg) return yield* new InvalidRequest({ parameter: "region", message: reg.error })
  const { out, provenance } = yield* compute("search", blocksFor(jd(fromMs), jd(toMs)), src =>
    searchWindowRequest(src, { body: q.body, targetLat: q.targetLat, targetLon: q.targetLon, targetHeight: q.targetHeight, targetHeightRef: q.targetHeightRef,
      height: q.height, heightRef: q.heightRef, region: reg.ok, encoding: q.region, startMs: start, temperature: q.temperature, pressure: q.pressure, dut1: q.dut1, aim: q.aim }),
    o => ("ok" in o ? { "ephem.passes": o.ok.passes.length, "ephem.region_vertices": o.ok.region.vertices, ...Object.fromEntries(Object.entries(o.ok.counters).map(([k, v]) => [`ephem.search.${k}`, v])) } : {}),
    geoidAcross(searchLatRange(reg.ok, q.targetLat)))
  if ("error" in out) return yield* new InvalidRequest({ message: out.error })
  return { ...out.ok, provenance } as SearchWindowResponse
})

/** The window GET for a POST: every parameter explicit (defaults filled), so equal searches share keys. */
export const windowQuery = (p: SearchPayload, encoding: string, startMs: number): WindowQuery => ({
  body: p.body, targetLat: p.targetLat, targetLon: p.targetLon, targetHeight: p.targetHeight, targetHeightRef: p.targetHeightRef ?? "ellipsoid",
  ...(p.height !== undefined ? { height: p.height, heightRef: p.heightRef ?? "ellipsoid" } : {}),
  region: encoding, start: isoMs(startMs), temperature: p.temperature ?? 10, pressure: p.pressure ?? 1010, dut1: p.dut1 ?? 0,
  ...(p.aim !== undefined ? { aim: p.aim } : {}),
})
export const windowPath = (q: WindowQuery): string =>
  canonical(new URL(`http://x${SEARCH_WINDOW_PATH}?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`))

const failFrom = (status: number, body: any) =>
  status === 400 ? new InvalidRequest({ message: String(body?.message ?? "invalid search"), ...(typeof body?.parameter === "string" ? { parameter: body.parameter } : {}) })
    : status === 503 ? new Unavailable({ message: String(body?.message ?? "geoid unavailable") })
    : undefined

type Pass = SearchWindowResponse["passes"][number]
/** A window's pass in the public shape (src: the window's every-field pass; docs/API.md "one vocabulary"). */
const publicPass = (x: Pass, include: ReadonlySet<string>) => ({
  time: x.time, segments: x.segments,
  standingPoint: { lat: x.standingPoint.lat, lon: x.standingPoint.lon, distanceKm: x.standingPoint.distanceKm },
  azimuth: x.standingPoint.azimuth, apparentAltitude: x.standingPoint.apparentAltitude, angularRadius: x.standingPoint.angularRadius,
  illuminatedFraction: x.moon.illuminated, sunAltitude: x.sunAlt,
  ...(include.has("sun") && x.sun ? { sun: x.sun } : {}), ...(include.has("phase") && x.phase ? { phase: x.phase } : {}),
})
const tally = (xs: ReadonlyArray<string>) => { const m = new Map<string, number>(); for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1); return [...m].map(([k, v]) => `${k}:${v}`).join(",") }

export const SearchLive = HttpApiBuilder.group(EphemApi, "search", h => h
  .handle("searchWindow", ({ query: q }) => windowAnswer(q).pipe(Effect.withSpan("search.window")))
  .handle("search", ({ payload: p, request }) => Effect.gen(function* () {
    const start = yield* parseUtc(p.start, "start"), end = yield* parseUtc(p.end, "end")
    if (end <= start) return yield* new InvalidRequest({ parameter: "end", message: `end=${p.end} must be after start=${p.start}` })
    if (end - start > SEARCH.maxSpanDays * 86_400_000) return yield* new InvalidRequest({ parameter: "end", message: `start…end spans ${((end - start) / 86_400_000).toFixed(1)} days; at most ${SEARCH.maxSpanDays} days per search (split it into several)` })
    const inc = parseInclude(p.include)
    if (p.include !== undefined && inc === null) return yield* new InvalidRequest({ parameter: "include", message: `include=${p.include}: comma-separated sun and/or phase`, allowed: ["sun", "phase", "sun,phase"] })
    const reg = parseRegion(p.region)
    if ("error" in reg) return yield* new InvalidRequest({ parameter: "region", message: reg.error })
    const encoding = encodeRegion(reg.ok), edge = yield* Edge
    const headers = forwardHeaders(request.headers)
    const windows = windowsFor(start, end)
    yield* Effect.annotateCurrentSpan({ "ephem.windows": windows.length, "ephem.region_vertices": reg.ok.reduce((s, x) => s + x.reduce((t, r) => t + r.length, 0), 0), "ephem.span_days": (end - start) / 86_400_000 })
    const results = yield* Effect.forEach(windows, w => Effect.gen(function* () {
      const q = windowQuery(p, encoding, w)
      if (edge.role !== "front") return { cache: "LOCAL", body: yield* windowAnswer(q) }
      const key = windowPath(q)
      const r = yield* Effect.tryPromise(() => edge.api(key, { method: "GET", headers })).pipe(Effect.orDie)
      const cache = r.headers.get("cf-cache-status") ?? "NONE"
      yield* Effect.annotateCurrentSpan({ "ephem.api_cache": cache, "http.status_code": r.status, "ephem.api_key": key.slice(0, 200) })
      const body = yield* Effect.tryPromise(() => r.json() as Promise<any>).pipe(Effect.orDie)
      if (r.status !== 200) { const e = failFrom(r.status, body); return e ? yield* e : yield* Effect.die(new Error(`window ${isoMs(w)}: ${r.status} ${JSON.stringify(body).slice(0, 300)}`)) }
      return { cache, body: body as SearchWindowResponse }
    }).pipe(Effect.withSpan("search.window.fetch", { attributes: { "ephem.window": isoMs(w) } })), { concurrency: "unbounded" })

    const first = results[0]!.body, include: ReadonlySet<string> = inc ?? new Set<string>()
    const all: Pass[] = results.flatMap(r => r.body.passes).filter(x => { const t = Date.parse(x.segments[0]!.enter.time); return t >= start && t < end })
    if (all.length > MAX_PASSES) return yield* new InvalidRequest({ message: `${all.length} passes; at most ${MAX_PASSES} per search: use a smaller region or a shorter start…end` })
    const kept = all.filter(x => (p.minIlluminated === undefined || x.moon.illuminated >= p.minIlluminated) && (p.maxSunAltitude === undefined || x.sunAlt <= p.maxSunAltitude))
      .map(x => publicPass(x, include))
    const counters: Record<string, number> = {}
    for (const r of results) for (const [k, v] of Object.entries(r.body.counters)) counters[k] = k === "maxSagittaM" ? Math.max(counters[k] ?? 0, v) : (counters[k] ?? 0) + v
    const statuses = results.map(r => r.cache)
    yield* Effect.annotateCurrentSpan({ "ephem.windows_cache": tally(statuses), "ephem.passes": kept.length, "ephem.passes_total": all.length, "ephem.segments": kept.reduce((s, x) => s + x.segments.length, 0), "ephem.search.anomalies": counters.anomalies ?? 0 })
    const blocks = [...new Set(results.flatMap(r => r.body.provenance.diagnostics?.blocks ?? []))].toSorted((a, b) => a - b)
    const computeMs = results.reduce((s, r) => s + (r.body.provenance.diagnostics?.computeMs ?? 0), 0)
    const cache: Record<string, number> = { windows: results.length }
    for (const s of statuses) cache[`window_${s.toLowerCase()}`] = (cache[`window_${s.toLowerCase()}`] ?? 0) + 1
    return {
      body: p.body, start: isoMs(start), end: isoMs(end), target: first.target, observer: first.observer, region: first.region,
      passes: kept,
      search: {
        geometry: first.geometry,
        windows: results.map(r => ({ start: r.body.start, end: r.body.end, passes: r.body.passes.length, cache: r.cache })),
        passesBeforeFilters: all.length, counters,
      },
      conventions: first.conventions,
      provenance: { ...PROV, diagnostics: { blocks, computeMs: Math.round(computeMs * 1000) / 1000, cache } },
    }
  }).pipe(Effect.withSpan("search"))))
