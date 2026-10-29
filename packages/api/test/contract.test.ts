import { describe, expect, it } from "vitest"
import { Effect, Layer, FileSystem, Path } from "effect"
import { Etag, HttpPlatform, HttpRouter } from "effect/http"
import { HttpApiBuilder, OpenApi } from "effect/http-api"
import { EphemApi } from "../src/index.ts"

const stubBody = { azimuth: 1, altitude: 2, apparentAltitude: 2.3, altitudeRate: 0.1, azimuthRate: 0.2, rightAscension: 3, declination: 4, distanceKm: 5, angularRadius: 0.26, eclipticLongitude: 6, eclipticLatitude: 0 }
const prov = { implementation: "stub", version: "0", ephemeris: "none" }
const obs = (q: { lat: number; lon: number; height?: number }) => ({ lat: q.lat, lon: q.lon, height: q.height ?? 0, heightEllipsoid: q.height ?? 0, heightMsl: 0, geoidUndulation: 0, heightRef: "default" as const })
const geoid = { model: "EGM96" as const, source: "stub", interpolationErrorM: { rms: 0, p99: 0, max: 0 } }
const horizon = { kind: "sea" as const, altitude: 0, dip: 0, terrestrialRefractionK: 0.13, profile: null }
const posConv = { refraction: { model: "stub", temperatureC: 10, pressureHpa: 1010, validFrom: 0, validTo: 90, uncertainty: "" }, horizon, geoid, rates: { unit: "deg/min" as const, method: "" } }
const dayConv = { riseSet: { limb: "upper" as const, definition: "", horizon, refraction: { model: "", temperatureC: 10, pressureHpa: 1010, atHorizon: 0.5667 }, trueLimbAltitude: -0.5667 },
  transit: "", twilight: { quantity: "", civil: -6, nautical: -12, astronomical: -18 }, goldenHour: { from: -4, to: 6 }, blueHour: { from: -6, to: -4 }, geoid }
const Sky = HttpApiBuilder.group(EphemApi, "sky", h => h
  .handle("position", ({ query }) => Effect.succeed({
    time: { utc: query.time ?? "2026-10-28T11:51:00Z", jdTT: 0, jdUT1: 0, dut1: query.dut1 ?? 0, deltaT: 0 }, observer: obs(query),
    sun: stubBody, moon: { ...stubBody, phase: { phaseAngle: 1, illuminatedFraction: 0.5, elongation: 90, brightLimbAngle: 270, name: "first quarter" as const } }, conventions: posConv, provenance: prov }))
  .handle("day", ({ query }) => Effect.succeed({ date: query.date, tz: query.tz, start: "2026-10-28T04:00:00Z", end: "2026-10-29T04:00:00Z", observer: obs(query), events: [], conventions: dayConv, provenance: prov }))
  .handle("crossing", ({ query }) => Effect.succeed({ body: query.body, start: "2026-10-28T04:00:00Z", end: "2026-10-29T04:00:00Z", observer: obs(query), crossings: [],
    conventions: { definition: "", limb: "center" as const, altitudeType: "true" as const, trueLimbAltitude: 0, refraction: null, horizon: null, geoid }, provenance: prov }))
  .handle("alignment", ({ query }) => Effect.succeed({ body: query.body, track: [], provenance: prov })))
const Earth = HttpApiBuilder.group(EphemApi, "earth", h => h
  .handle("magnetic", ({ query }) => Effect.succeed({ time: "2026-10-28T11:51:00Z", observer: { lat: query.lat, lon: query.lon, height: 0 },
    magnetic: { model: "WMM2025" as const, declination: -12.5, inclination: 66, horizontalIntensityNt: 2e4, totalIntensityNt: 5e4, decimalYear: 2026.8, inValidityWindow: true } }))
  .handle("weather", ({ query }) => Effect.succeed({ time: "2026-10-28T11:51:00Z", observer: { lat: query.lat, lon: query.lon, magneticDeclination: -12.5 }, stations: [],
    feed: { source: "stub", fetchedAt: "2026-10-28T11:51:00Z", ageSeconds: query.n ?? 1, lastModified: null, upstreamAgeSeconds: null, stale: false, tier: "hit" as const, stations: 0 } })))
const Meta = HttpApiBuilder.group(EphemApi, "meta", h => h.handle("health", () => Effect.succeed({ ok: true as const, implementation: "stub", version: "0" })))
const Platform = Layer.mergeAll(HttpPlatform.layer, FileSystem.layerNoop({}), Path.layer, Etag.layerWeak).pipe(Layer.provideMerge(FileSystem.layerNoop({})))
const App = HttpApiBuilder.layer(EphemApi, { openapiPath: "/openapi.json" }).pipe(Layer.provide([Sky, Earth, Meta]), Layer.provide(Platform))
const { handler } = HttpRouter.toWebHandler(App, { disableLogger: true })
const get = (p: string) => handler(new Request("http://x" + p))

describe("contract", () => {
  it("decodes numeric query params and applies defaults", async () => {
    const r = await get("/v1/position?lat=40.7127&lon=-74.0059&time=2026-10-28T11:51:00Z")
    expect(r.status).toBe(200)
    const j = await r.json() as any
    expect(j.observer).toMatchObject({ lat: 40.7127, lon: -74.0059, height: 0 })
  })
  it("rejects out-of-range latitude and malformed time", async () => {
    expect((await get("/v1/position?lat=91&lon=0&time=2026-10-28T11:51:00Z")).status).toBe(400)
    expect((await get("/v1/position?lat=0&lon=0&time=2026-10-28 11:51")).status).toBe(400)
  })
  it("weather: n is an integer 1..10", async () => {
    expect(((await (await get("/v1/weather?lat=40.7&lon=-74&n=3")).json()) as any).feed.ageSeconds).toBe(3)
    expect((await get("/v1/weather?lat=40.7&lon=-74&n=11")).status).toBe(400)
    expect((await get("/v1/weather?lat=40.7&lon=-74&n=1.5")).status).toBe(400)
  })
  it("serves OpenAPI", async () => {
    const spec = OpenApi.fromApi(EphemApi) as any
    expect(Object.keys(spec.paths)).toEqual(expect.arrayContaining(["/v1/position", "/v1/day", "/v1/alignment", "/v1/weather", "/v1/magnetic"]))
  })
})
