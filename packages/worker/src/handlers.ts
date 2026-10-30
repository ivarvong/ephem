// HttpApi handlers: decode → compute block set → load → pure core → response with diagnostics.
import { Clock, Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/http-api"
import { EphemApi, InvalidInput, OutOfRange } from "@ephem/api"
import { SUPPORTED, TRACK_DEFAULT_STEP_S, alignment, blocksFor, crossingRequest, crossingWindow, dayRequest, instant, instrumented, isValidZone, localMidnight, nextDate, positionRequest, trackRequest, trackWindowError } from "@ephem/core"
import { Blocks, blocksCache } from "./blocks.ts"
import { EarthLive } from "./weather.ts"

export const VERSION = "0.1.0"
const PROV = { implementation: "@ephem/worker", version: VERSION, ephemeris: "JPL DE440 (linux_p1550p2650.440)" }

const parseUtc = (s: string) => Effect.gen(function* () {
  const ms = Date.parse(s)
  if (!Number.isFinite(ms)) return yield* new InvalidInput({ message: `not a UTC instant: ${s}` })
  if (ms < SUPPORTED.fromMs || ms >= SUPPORTED.toMs) return yield* new OutOfRange({ message: `${s} is outside 1972-01-01 … 2149-12-31 UTC` })
  return ms
})
const jd = (ms: number) => instant(ms).jdTDB

type Attrs = Record<string, string | number | boolean | undefined>
const prefix = (p: string, o: object): Attrs => Object.fromEntries(Object.entries(o).map(([k, v]) => [p + k, v]))

/** Computations this isolate has run, this one included: 1 = a fresh isolate (cold JIT, empty L1, lazy tables). */
let isolateComputes = 0
/** Run a pure computation over prefetched blocks, timing it and attaching diagnostics; spans carry cache tiers and work counts. */
const compute = <A>(name: string, blocks: ReadonlyArray<number>, f: (src: Parameters<typeof instrumented>[0]) => A, attrs: (out: A) => Attrs = () => ({})) => Effect.gen(function* () {
  const { load } = yield* Blocks
  const loaded = yield* load(blocks).pipe(
    Effect.tap(l => Effect.annotateCurrentSpan({ ...prefix("cache.", l.stats), "ephem.blocks_cache": blocksCache(l.stats) })),
    Effect.withSpan("blocks.load", { attributes: { "blocks.count": blocks.length } }), Effect.orDie)
  const { src, stats } = instrumented(loaded.src)
  const t0 = performance.now()
  const out = yield* Effect.sync(() => f(src)).pipe(
    Effect.tap(o => Effect.annotateCurrentSpan({ "ephem.block_reads": stats.reads, "ephem.blocks": stats.blocks.size, ...attrs(o) })),
    Effect.withSpan(`compute.${name}`))
  const computeMs = performance.now() - t0
  yield* Effect.annotateCurrentSpan({ computeMs, blocks: stats.blocks.size, reads: stats.reads, ...loaded.stats, "ephem.isolate_computes": ++isolateComputes })
  return { out, provenance: { ...PROV, diagnostics: { blocks: [...stats.blocks].toSorted((a, b) => a - b), computeMs: Math.round(computeMs * 1000) / 1000, cache: { ...loaded.stats, reads: stats.reads } } } }
})

export const SkyLive = HttpApiBuilder.group(EphemApi, "sky", h => h
  .handle("position", ({ query: q }) => Effect.gen(function* () {
    const ms = q.time === undefined ? yield* Clock.currentTimeMillis : yield* parseUtc(q.time)
    const { out, provenance } = yield* compute("position", blocksFor(jd(ms), jd(ms)), src =>
      positionRequest(src, { utcMs: ms, lat: q.lat, lon: q.lon, height: q.height, heightRef: q.heightRef, temperature: q.temperature, pressure: q.pressure, horizon: q.horizon, dut1: q.dut1 }))
    return { ...out, provenance }
  }).pipe(Effect.withSpan("position")))
  .handle("day", ({ query: q }) => Effect.gen(function* () {
    if (!isValidZone(q.tz)) return yield* new InvalidInput({ message: `unknown IANA time zone: ${q.tz}` })
    const t0 = localMidnight(q.date, q.tz), t1 = localMidnight(nextDate(q.date), q.tz)
    if (t0 < SUPPORTED.fromMs || t1 >= SUPPORTED.toMs) return yield* new OutOfRange({ message: `${q.date} is outside the supported range` })
    const { out, provenance } = yield* compute("day", blocksFor(jd(t0), jd(t1)), src =>
      dayRequest(src, { date: q.date, tz: q.tz, lat: q.lat, lon: q.lon, height: q.height, heightRef: q.heightRef, temperature: q.temperature, pressure: q.pressure,
        horizon: q.horizon, horizonProfile: q.horizonProfile, limb: q.limb, dut1: q.dut1 }), o => ("ok" in o ? { "ephem.events": o.ok.events.length } : {}))
    if ("error" in out) return yield* new InvalidInput({ message: out.error })
    return { ...out.ok, provenance }
  }).pipe(Effect.withSpan("day")))
  .handle("crossing", ({ query: q }) => Effect.gen(function* () {
    if (q.tz !== undefined && !isValidZone(q.tz)) return yield* new InvalidInput({ message: `unknown IANA time zone: ${q.tz}` })
    if (q.start !== undefined) yield* parseUtc(q.start)
    if (q.end !== undefined) yield* parseUtc(q.end)
    const w = crossingWindow(q)
    if ("error" in w) return yield* new InvalidInput({ message: w.error })
    const { startMs, endMs } = w.ok
    if (startMs < SUPPORTED.fromMs || endMs >= SUPPORTED.toMs) return yield* new OutOfRange({ message: "the window is outside 1972-01-01 … 2149-12-31 UTC" })
    const { out, provenance } = yield* compute("crossing", blocksFor(jd(startMs), jd(endMs)), src =>
      crossingRequest(src, { startMs, endMs, lat: q.lat, lon: q.lon, height: q.height, heightRef: q.heightRef, body: q.body, altitude: q.altitude, altitudeType: q.altitudeType,
        horizonProfile: q.horizonProfile, limb: q.limb, direction: q.direction, temperature: q.temperature, pressure: q.pressure, dut1: q.dut1 }),
      o => ("ok" in o ? { "ephem.crossings": o.ok.crossings.length } : {}))
    if ("error" in out) return yield* new InvalidInput({ message: out.error })
    return { ...out.ok, provenance }
  }).pipe(Effect.withSpan("crossing")))
  .handle("alignment", ({ query: q }) => Effect.gen(function* () {
    const start = yield* parseUtc(q.start), end = yield* parseUtc(q.end), step = q.stepSeconds ?? 60
    if (end <= start) return yield* new InvalidInput({ message: "end must be after start" })
    if ((end - start) / 1000 / step > 2000) return yield* new InvalidInput({ message: "at most 2000 steps per request" })
    if ((q.observerLat === undefined) !== (q.observerLon === undefined)) return yield* new InvalidInput({ message: "observerLat and observerLon go together" })
    const { out, provenance } = yield* compute("alignment", blocksFor(jd(start), jd(end)), src =>
      alignment(src, { body: q.body, target: { lat: q.targetLat, lon: q.targetLon, height: q.targetHeight }, observerHeight: q.observerHeight ?? 0,
        startMs: start, endMs: end, stepSeconds: step, maxDistanceKm: q.maxDistanceKm ?? 20, temperature: q.temperature, pressure: q.pressure, dut1: q.dut1,
        ...(q.observerLat !== undefined && q.observerLon !== undefined ? { observer: { lat: q.observerLat, lon: q.observerLon } } : {}) }),
      o => ({ "ephem.instants": Math.floor((end - start) / 1000 / step) + 1, "ephem.track_points": o.track.length, "ephem.iterations": o.track.reduce((s, p) => s + p.iterations, 0), "ephem.passes": o.fromObserver?.passes.length }))
    const track = out.track.map(({ iterations: _i, ...p }) => p)
    return { body: out.body, track, ...(out.fromObserver ? { fromObserver: out.fromObserver } : {}), provenance }
  }).pipe(Effect.withSpan("alignment")))
  .handle("track", ({ query: q }) => Effect.gen(function* () {
    const start = yield* parseUtc(q.start), end = yield* parseUtc(q.end), step = q.stepSeconds ?? TRACK_DEFAULT_STEP_S
    const bad = trackWindowError(start, end, step)
    if (bad) return yield* new InvalidInput({ message: bad })
    const { out, provenance } = yield* compute("track", blocksFor(jd(start), jd(end)), src =>
      trackRequest(src, { lat: q.lat, lon: q.lon, height: q.height, heightRef: q.heightRef, startMs: start, endMs: end, stepSeconds: step,
        temperature: q.temperature, pressure: q.pressure, horizon: q.horizon, dut1: q.dut1 }), o => ({ "ephem.instants": o.count }))
    return { ...out, provenance }
  }).pipe(Effect.withSpan("track"))))

export const MetaLive = HttpApiBuilder.group(EphemApi, "meta", h =>
  h.handle("health", () => Effect.succeed({ ok: true as const, implementation: PROV.implementation, version: VERSION })))

export const HandlersLive = Layer.mergeAll(SkyLive, EarthLive, MetaLive)
