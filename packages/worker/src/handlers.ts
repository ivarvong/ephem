// HttpApi handlers: decode → compute block set → load → pure core → response with diagnostics.
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { EphemApi, InvalidRequest } from "@ephem/api"
import { SUPPORTED, TRACK_DEFAULT_STEP_S, alignmentLatRange, alignmentRequest, blocksFor, parseInclude, parseObstacles, sightline, SIGHTLINE_CONVENTIONS, MAX_SIGHTLINE_KM, inverse, K_TERRESTRIAL, GEOID, crossingRequest, crossingWindow, dayRequest, instant, instrumented, isValidZone, localMidnight, nextDate, positionRequest, trackRequest, trackWindowError } from "@ephem/core"
import { Blocks, blocksCache } from "./blocks.ts"
import { Geoid, geoidCache } from "./geoid.ts"
import { EarthLive } from "./weather.ts"

export { PROV, SOURCES, VERSION, prov } from "./provenance.ts"
import { PROV, SOURCES, VERSION, prov } from "./provenance.ts"

export const parseUtc = (s: string, parameter = "time") => Effect.gen(function* () {
  const ms = Date.parse(s)
  if (!Number.isFinite(ms)) return yield* new InvalidRequest({ parameter, message: `${parameter}=${s} is not a real UTC instant: ISO-8601 with a trailing Z, e.g. 2026-11-17T03:45:00Z` })
  if (ms < SUPPORTED.fromMs || ms >= SUPPORTED.toMs) return yield* new InvalidRequest({ parameter, message: `${parameter}=${s} is outside the supported range 1972-01-01T00:00:00Z to 2149-12-31T23:59:59Z (DE440 with leap seconds)` })
  return ms
})
const badZone = (tz: string) => new InvalidRequest({ parameter: "tz", message: `tz=${tz} is not an IANA time zone: use a name like America/New_York, Europe/Oslo or UTC` })
export const jd = (ms: number) => instant(ms).jdTDB

type Attrs = Record<string, string | number | boolean | undefined>
const prefix = (p: string, o: object): Attrs => Object.fromEntries(Object.entries(o).map(([k, v]) => [p + k, v]))

/** Computations this isolate has run, this one included: 1 = a fresh isolate (cold JIT, empty L1, lazy tables). */
let isolateComputes = 0
/** The EGM96 bands an observer at `lat` needs (every route with an observer: position, day, crossing, track). */
const geoidAt = (lat: number) => Effect.gen(function* () {
  const s = yield* (yield* Geoid).load(lat)
  yield* Effect.annotateCurrentSpan({ ...s, "ephem.geoid_cache": geoidCache(s) })
}).pipe(Effect.withSpan("geoid.load"))
/** Every geoid band a latitude range touches (alignment: standing points within maxDistanceKm of the target), plus `extra`. */
export const geoidAcross = ([lo, hi]: [number, number], ...extra: number[]) => {
  const lats = [lo, hi, ...extra]; for (let x = lo + 1; x < hi; x += 1) lats.push(x)   // bands are 4° tall: 1° steps miss none
  return Effect.all(lats.map(geoidAt), { concurrency: "unbounded", discard: true })
}
/** Run a pure computation over prefetched blocks (and whatever `pre` loads concurrently: the observer's geoid bands),
 *  timing it and attaching diagnostics; spans carry cache tiers and work counts. */
export const compute = <A, E = never, R = never>(name: string, blocks: ReadonlyArray<number>, f: (src: Parameters<typeof instrumented>[0]) => A, attrs: (out: A) => Attrs = () => ({}),
  pre: Effect.Effect<void, E, R> = Effect.void as Effect.Effect<void, E, R>) => Effect.gen(function* () {
  const { load } = yield* Blocks
  const blocksLoad = load(blocks).pipe(
    Effect.tap(l => Effect.annotateCurrentSpan({ ...prefix("cache.", l.stats), "ephem.blocks_cache": blocksCache(l.stats) })),
    Effect.withSpan("blocks.load", { attributes: { "blocks.count": blocks.length } }), Effect.orDie)
  const [loaded] = yield* Effect.all([blocksLoad, pre], { concurrency: 2 })
  const { src, stats } = instrumented(loaded.src)
  const t0 = performance.now()
  const out = yield* Effect.sync(() => f(src)).pipe(
    Effect.tap(o => Effect.annotateCurrentSpan({ "ephem.block_reads": stats.reads, "ephem.blocks": stats.blocks.size, ...attrs(o) })),
    Effect.withSpan(`compute.${name}`))
  const computeMs = performance.now() - t0
  yield* Effect.annotateCurrentSpan({ computeMs, blocks: stats.blocks.size, reads: stats.reads, ...loaded.stats, "ephem.isolate_computes": ++isolateComputes })
  return { out, provenance: { ...(blocks.length ? PROV : prov(SOURCES.egm96)), diagnostics: { blocks: [...stats.blocks].toSorted((a, b) => a - b), computeMs: Math.round(computeMs * 1000) / 1000, cache: { ...loaded.stats, reads: stats.reads } } } }
})

export const SkyLive = HttpApiBuilder.group(EphemApi, "sky", h => h
  .handle("position", ({ query: q }) => Effect.gen(function* () {
    const ms = q.time === undefined ? yield* Clock.currentTimeMillis : yield* parseUtc(q.time)
    const { out, provenance } = yield* compute("position", blocksFor(jd(ms), jd(ms)), src =>
      positionRequest(src, { utcMs: ms, lat: q.lat, lon: q.lon, height: q.height, heightRef: q.heightRef, temperature: q.temperature, pressure: q.pressure, horizon: q.horizon, dut1: q.dut1 }), undefined, geoidAt(q.lat))
    return { ...out, provenance }
  }).pipe(Effect.withSpan("position")))
  .handle("day", ({ query: q }) => Effect.gen(function* () {
    if (!isValidZone(q.tz)) return yield* badZone(q.tz)
    const t0 = localMidnight(q.date, q.tz), t1 = localMidnight(nextDate(q.date), q.tz)
    if (t0 < SUPPORTED.fromMs || t1 >= SUPPORTED.toMs) return yield* new InvalidRequest({ parameter: "date", message: `date=${q.date} is outside the supported range 1972-01-01 to 2149-12-31` })
    const { out, provenance } = yield* compute("day", blocksFor(jd(t0), jd(t1)), src =>
      dayRequest(src, { date: q.date, tz: q.tz, lat: q.lat, lon: q.lon, height: q.height, heightRef: q.heightRef, temperature: q.temperature, pressure: q.pressure,
        horizon: q.horizon, horizonProfile: q.horizonProfile, aim: q.aim, dut1: q.dut1 }), o => ("ok" in o ? { "ephem.events": o.ok.events.length } : {}), geoidAt(q.lat))
    if ("error" in out) return yield* new InvalidRequest({ message: out.error })
    return { ...out.ok, provenance }
  }).pipe(Effect.withSpan("day")))
  .handle("crossing", ({ query: q }) => Effect.gen(function* () {
    if (q.tz !== undefined && !isValidZone(q.tz)) return yield* badZone(q.tz)
    if (q.start !== undefined) yield* parseUtc(q.start, "start")
    if (q.end !== undefined) yield* parseUtc(q.end, "end")
    const w = crossingWindow(q)
    if ("error" in w) return yield* new InvalidRequest({ message: w.error })
    const { startMs, endMs } = w.ok
    if (startMs < SUPPORTED.fromMs || endMs >= SUPPORTED.toMs) return yield* new InvalidRequest({ message: "the window is outside the supported range 1972-01-01 to 2149-12-31 UTC" })
    const { out, provenance } = yield* compute("crossing", blocksFor(jd(startMs), jd(endMs)), src =>
      crossingRequest(src, { startMs, endMs, lat: q.lat, lon: q.lon, height: q.height, heightRef: q.heightRef, body: q.body, altitude: q.altitude, altitudeType: q.altitudeType,
        horizonProfile: q.horizonProfile, direction: q.direction, temperature: q.temperature, pressure: q.pressure, dut1: q.dut1, include: parseInclude(q.include) ?? undefined, aim: q.aim }),
      o => ("ok" in o ? { "ephem.crossings": o.ok.crossings.length } : {}), geoidAt(q.lat))
    if ("error" in out) return yield* new InvalidRequest({ message: out.error })
    return { ...out.ok, provenance }
  }).pipe(Effect.withSpan("crossing")))
  .handle("alignment", ({ query: q }) => Effect.gen(function* () {
    const start = yield* parseUtc(q.start, "start"), end = yield* parseUtc(q.end, "end"), step = q.stepSeconds ?? 60
    if (end <= start) return yield* new InvalidRequest({ parameter: "end", message: `end=${q.end} must be after start=${q.start}` })
    if ((end - start) / 1000 / step > 2000) return yield* new InvalidRequest({ parameter: "stepSeconds", message: `${Math.floor((end - start) / 1000 / step)} steps of ${step} s; at most 2000 per request: raise stepSeconds to ≥ ${Math.ceil((end - start) / 1000 / 2000)} or shorten start…end` })
    if ((q.lat === undefined) !== (q.lon === undefined)) return yield* new InvalidRequest({ parameter: q.lat === undefined ? "lat" : "lon", message: "lat and lon go together (a fixed spot to watch the pass from); omit both for where-to-stand only" })
    if (q.aim === "litCentroid" && q.body !== "moon") return yield* new InvalidRequest({ parameter: "aim", message: "aim=litCentroid is the Moon's lit-area centroid: it needs body=moon (for the Sun use center, upper or lower)", allowed: ["center", "upper", "lower"] })
    const maxDistanceKm = q.maxDistanceKm ?? 20
    const observer = q.lat !== undefined && q.lon !== undefined ? { lat: q.lat, lon: q.lon } : undefined
    const { out, provenance } = yield* compute("alignment", blocksFor(jd(start), jd(end)), src =>
      alignmentRequest(src, { body: q.body, targetLat: q.targetLat, targetLon: q.targetLon, targetHeight: q.targetHeight, targetHeightRef: q.targetHeightRef,
        height: q.height, heightRef: q.heightRef, startMs: start, endMs: end, stepSeconds: step, maxDistanceKm,
        temperature: q.temperature, pressure: q.pressure, dut1: q.dut1, observer, include: parseInclude(q.include) ?? undefined, aim: q.aim }),
      o => ({ "ephem.instants": Math.floor((end - start) / 1000 / step) + 1, "ephem.track_points": o.track.length, "ephem.iterations": o.track.reduce((s, p) => s + p.iterations, 0), "ephem.passes": o.fromObserver?.passes.length }),
      geoidAcross(alignmentLatRange(q.targetLat, maxDistanceKm), ...(observer ? [observer.lat] : [])))
    const track = out.track.map(({ iterations: _i, ...p }) => p)
    return { ...out, track, provenance }
  }).pipe(Effect.withSpan("alignment")))
  .handle("sightline", ({ query: q }) => Effect.gen(function* () {
    const obstacles = parseObstacles(q.obstacles)
    if (typeof obstacles === "string") return yield* new InvalidRequest({ parameter: "obstacles", message: obstacles })
    const km = inverse(q.lat, q.lon, q.targetLat, q.targetLon).distanceM / 1000
    if (km > MAX_SIGHTLINE_KM) return yield* new InvalidRequest({ message: `the eye (lat, lon) and the target (targetLat, targetLon) are ${km.toFixed(1)} km apart; at most ${MAX_SIGHTLINE_KM} km` })
    if (km < 0.001) return yield* new InvalidRequest({ message: "the eye (lat, lon) and the target (targetLat, targetLon) are at the same place (< 1 m apart)" })
    // Geoid bands for every latitude the line and the obstacles touch.
    const lats = [q.lat, q.targetLat, ...obstacles.map(o => o.lat)], lo = Math.min(...lats), hi = Math.max(...lats)
    const { out, provenance } = yield* compute("sightline", [], () => sightline({
      observer: q.height === undefined ? { lat: q.lat, lon: q.lon, height: 0, heightRef: "msl" } : { lat: q.lat, lon: q.lon, height: q.height, heightRef: q.heightRef },
      target: { lat: q.targetLat, lon: q.targetLon, height: q.targetHeight, heightRef: q.targetHeightRef },
      samples: q.samples ?? 101, obstacles }), o => ({ "ephem.instants": o.samples, "ephem.obstacles": o.obstacles.length }), geoidAcross([lo, hi]))
    const observer = { ...out.observer, heightRef: q.height === undefined ? "default" as const : out.observer.heightRef }
    return { ...out, observer, conventions: { ...SIGHTLINE_CONVENTIONS, terrestrialRefractionK: K_TERRESTRIAL, geoid: { model: GEOID.model, source: GEOID.source, interpolationErrorM: GEOID.interpolationErrorM } }, provenance }
  }).pipe(Effect.withSpan("sightline")))
  .handle("track", ({ query: q }) => Effect.gen(function* () {
    const start = yield* parseUtc(q.start, "start"), end = yield* parseUtc(q.end, "end"), step = q.stepSeconds ?? TRACK_DEFAULT_STEP_S
    const bad = trackWindowError(start, end, step)
    if (bad) return yield* new InvalidRequest({ message: bad })
    const { out, provenance } = yield* compute("track", blocksFor(jd(start), jd(end)), src =>
      trackRequest(src, { lat: q.lat, lon: q.lon, height: q.height, heightRef: q.heightRef, startMs: start, endMs: end, stepSeconds: step,
        temperature: q.temperature, pressure: q.pressure, horizon: q.horizon, dut1: q.dut1 }), o => ({ "ephem.instants": o.count }), geoidAt(q.lat))
    return { ...out, provenance }
  }).pipe(Effect.withSpan("track"))))

export const MetaLive = HttpApiBuilder.group(EphemApi, "meta", h =>
  h.handle("health", () => Effect.succeed({ ok: true as const, implementation: PROV.implementation, version: VERSION })))

export const HandlersLive = Layer.mergeAll(SkyLive, EarthLive, MetaLive)
