// /v1/weather and /v1/magnetic. The weather lookup is a plain Effect service (Weather.nearest), so any front end (the HTTP
// handler, an MCP tool) gets the same cache tiers, span attributes and log line.
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import { EphemApi, InvalidInput, OutOfRange, WeatherUnavailable, type WeatherResponse } from "@ephem/api"
import { SUPPORTED, WMM_VALID, decimalYear, wmm } from "@ephem/core"
import { nearest, type Metar } from "./metar.ts"
import { currentTraceparent } from "./trace.ts"
import { FEED_URL, FRESH_MS, type Feed, type FeedResult } from "./metar-feed.ts"

/** METARs are hourly; an observation older than this is flagged. */
export const OBS_STALE_S = 75 * 60
const INHG_HPA = 33.8638866667
const iso = (ms: number) => new Date(Math.round(ms)).toISOString()
const r2 = (x: number) => Math.round(x * 100) / 100
const wrap = (x: number) => ((x % 360) + 360) % 360
const httpDate = (s: string | null) => { if (!s) return null; const t = Date.parse(s); return Number.isFinite(t) ? t : null }

export const declinationAt = (lat: number, lon: number, utcMs: number, heightM = 0) => wmm(lat, lon, heightM / 1000, decimalYear(utcMs))

export class Weather extends Context.Service<Weather, {
  readonly nearest: (q: { readonly lat: number; readonly lon: number; readonly n?: number | undefined }) => Effect.Effect<WeatherResponse, WeatherUnavailable>
}>()("@ephem/worker/Weather") {}

const station = (s: Metar, distanceKm: number, bearing: number, decl: number, now: number) => {
  const ageS = Math.max(0, (now - s.observationMs) / 1000)
  return {
    stationId: s.stationId, raw: s.raw, metarType: s.metarType, flightCategory: s.flightCategory,
    observationTime: iso(s.observationMs), observationAgeSeconds: Math.round(ageS), observationStale: ageS > OBS_STALE_S,
    lat: s.lat, lon: s.lon, elevationM: s.elevationM,
    distanceKm: Math.round(distanceKm * 1000) / 1000,
    bearing: { true: r2(bearing) % 360, magnetic: r2(wrap(bearing - decl)) % 360 },
    temperatureC: s.temperatureC, dewpointC: s.dewpointC,
    wind: { directionDegTrue: s.windDirectionDeg, variable: s.windVariable, calm: s.windSpeedKt === 0, speedKt: s.windSpeedKt, gustKt: s.windGustKt },
    visibility: { statuteMiles: s.visibilityMi, orMore: s.visibilityPlus },
    altimeterInHg: s.altimeterInHg, altimeterHpa: s.altimeterInHg === null ? null : Math.round(s.altimeterInHg * INHG_HPA * 10) / 10,
    seaLevelPressureHpa: s.seaLevelPressureMb, wx: s.wx, sky: s.sky, verticalVisibilityFt: s.verticalVisibilityFt,
  }
}

/** One structured line per weather request: the feed tier (cf-cache-status of the MetarFeed loopback), data age, and
 *  whether this request read and parsed a new feed version. Upstream calls are logged by MetarFeed ({"evt":"metar.upstream"}). */
const logLine = (f: FeedResult | undefined, extra: Record<string, unknown>) => console.log(JSON.stringify({
  evt: "metar", tier: f?.tier ?? "unavailable", dataAgeS: f ? Math.round(f.dataAgeMs / 1000) : null,
  bytes: f?.bytes ?? 0, parsed: f?.parsed ?? false, version: f?.snap.version ?? null, error: f?.error ?? null, ...extra,
}))

export const weatherLive = (feed: Feed) => Layer.succeed(Weather, {
  nearest: q => Effect.gen(function* () {
    const tp = yield* currentTraceparent
    const f = yield* Effect.tryPromise({ try: () => feed.get(tp), catch: e => new WeatherUnavailable({ message: `METAR feed unavailable: ${e instanceof Error ? e.message : String(e)}` }) }).pipe(
      Effect.tapError(e => Effect.sync(() => logLine(undefined, { error: e.message }))),
      Effect.tap(r => Effect.annotateCurrentSpan({
        "metar.tier": r.tier, "ephem.feed_cache": r.tier.toUpperCase(), "metar.data_age_s": Math.round(r.dataAgeMs / 1000), "metar.bytes": r.bytes, "metar.parsed": r.parsed,
        "metar.version": r.snap.version, "metar.stations": r.snap.table.count, "metar.error": r.error ?? "",
      })),
      Effect.withSpan("metar.feed"))
    const now = yield* Clock.currentTimeMillis
    const decl = declinationAt(q.lat, q.lon, now).declination
    const n = q.n ?? 1
    const near = yield* Effect.sync(() => nearest(f.snap.table, q.lat, q.lon, n)).pipe(
      Effect.tap(r => Effect.annotateCurrentSpan({ "metar.n": n, "metar.nearest": r[0]?.station.stationId ?? "", "metar.nearest_km": r[0] ? Math.round(r[0].distanceKm) : -1 })),
      Effect.withSpan("metar.nearest"))
    logLine(f, { n, nearest: near[0]?.station.stationId ?? null, km: near[0] ? Math.round(near[0].distanceKm) : null })
    const lm = httpDate(f.snap.lastModified)
    return {
      time: iso(now),
      observer: { lat: q.lat, lon: q.lon, magneticDeclination: decl },   // full precision: the homepage takes its magnetic bearings from it (no /v1/magnetic call)
      stations: near.map(x => station(x.station, x.distanceKm, x.bearing, decl, now)),
      feed: {
        source: FEED_URL, fetchedAt: iso(f.snap.fetchedAt), ageSeconds: Math.round(f.dataAgeMs / 1000),
        lastModified: lm === null ? null : iso(lm), upstreamAgeSeconds: lm === null ? null : Math.round((now - lm) / 1000),
        stale: f.dataAgeMs >= FRESH_MS, tier: f.tier, stations: f.snap.table.count,
      },
    }
  }).pipe(Effect.withSpan("weather")),
})

/** No feed (tests that don't need one, the Node dev server without network). */
export const WeatherNone = Layer.succeed(Weather, { nearest: () => Effect.fail(new WeatherUnavailable({ message: "no METAR feed configured" })) })

export const EarthLive = HttpApiBuilder.group(EphemApi, "earth", h => h
  .handle("magnetic", ({ query: q }) => Effect.gen(function* () {
    let ms: number
    if (q.time === undefined) ms = yield* Clock.currentTimeMillis
    else {
      ms = Date.parse(q.time)
      if (!Number.isFinite(ms)) return yield* new InvalidInput({ message: `not a UTC instant: ${q.time}` })
      if (ms < SUPPORTED.fromMs || ms >= SUPPORTED.toMs) return yield* new OutOfRange({ message: `${q.time} is outside 1972-01-01 … 2149-12-31 UTC` })
    }
    const height = q.height ?? 0, year = decimalYear(ms), m = declinationAt(q.lat, q.lon, ms, height)
    return {
      time: iso(ms), observer: { lat: q.lat, lon: q.lon, height },
      magnetic: { model: "WMM2025" as const, declination: m.declination, inclination: m.inclination, horizontalIntensityNt: m.h, totalIntensityNt: m.f,
        decimalYear: year, inValidityWindow: year >= WMM_VALID.from && year < WMM_VALID.to },
    }
  }).pipe(Effect.withSpan("magnetic")))
  .handle("weather", ({ query: q }) => Effect.gen(function* () { const w = yield* Weather; return yield* w.nearest(q) })))
