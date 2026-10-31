import { describe, expect, it } from "vitest"
import { Effect, Layer, FileSystem, Path } from "effect"
import { Etag, HttpPlatform, HttpRouter } from "effect/http"
import { HttpApiBuilder, OpenApi } from "effect/http-api"
import { EphemApi } from "../src/index.ts"

const stubBody = {
  azimuth: 1,
  altitude: 2,
  apparentAltitude: 2.3,
  altitudeRate: 0.1,
  azimuthRate: 0.2,
  rightAscension: 3,
  declination: 4,
  distanceKm: 5,
  angularRadius: 0.26,
  eclipticLongitude: 6,
  eclipticLatitude: 0,
}
const prov = { implementation: "stub", version: "0", sources: ["none"] }
const obs = (q: { lat: number; lon: number; height?: number }) => ({
  lat: q.lat,
  lon: q.lon,
  height: q.height ?? 0,
  heightEllipsoid: q.height ?? 0,
  heightMsl: 0,
  geoidUndulation: 0,
  heightRef: "default" as const,
})
const geoid = { model: "EGM96" as const, source: "stub", interpolationErrorM: { rms: 0, p99: 0, max: 0 } }
const horizon = { kind: "sea" as const, altitude: 0, dip: 0, terrestrialRefractionK: 0.13, profile: null }
const posConv = {
  refraction: { model: "stub", temperatureC: 10, pressureHpa: 1010, validFrom: 0, validTo: 90, uncertainty: "" },
  horizon,
  geoid,
  rates: { unit: "deg/min" as const, method: "" },
}
const dayConv = {
  riseSet: {
    aim: { point: "upper" as const, definition: "" },
    definition: "",
    horizon,
    refraction: { model: "", temperatureC: 10, pressureHpa: 1010, atHorizon: 0.5667 },
    trueLimbAltitude: -0.5667,
  },
  transit: "",
  twilight: { quantity: "", civil: -6, nautical: -12, astronomical: -18 },
  goldenHour: { from: -4, to: 6 },
  blueHour: { from: -6, to: -4 },
  geoid,
}
const Sky = HttpApiBuilder.group(EphemApi, "sky", (h) =>
  h
    .handle("position", ({ query }) =>
      Effect.succeed({
        time: { utc: query.time ?? "2026-10-28T11:51:00Z", jdTT: 0, jdUT1: 0, dut1: query.dut1 ?? 0, deltaT: 0 },
        observer: obs(query),
        sun: stubBody,
        moon: {
          ...stubBody,
          phase: {
            phaseAngle: 1,
            illuminatedFraction: 0.5,
            elongation: 90,
            brightLimbAngle: 270,
            name: "first quarter" as const,
          },
          brightLimbAngleFromVertical: 0,
        },
        conventions: posConv,
        provenance: prov,
      }),
    )
    .handle("day", ({ query }) =>
      Effect.succeed({
        date: query.date,
        tz: query.tz,
        start: "2026-10-28T04:00:00Z",
        end: "2026-10-29T04:00:00Z",
        observer: obs(query),
        events: [],
        conventions: dayConv,
        provenance: prov,
      }),
    )
    .handle("crossing", ({ query }) =>
      Effect.succeed({
        body: query.body,
        start: "2026-10-28T04:00:00Z",
        end: "2026-10-29T04:00:00Z",
        observer: obs(query),
        crossings: [],
        conventions: {
          definition: "",
          aim: { point: "center" as const, definition: "" },
          altitudeType: "true" as const,
          trueLimbAltitude: 0,
          refraction: null,
          horizon: null,
          geoid,
        },
        provenance: prov,
      }),
    )
    .handle("alignment", ({ query }) =>
      Effect.succeed({
        body: query.body,
        target: obs({ lat: query.targetLat, lon: query.targetLon, height: query.targetHeight }),
        track: [],
        conventions: {
          definition: "",
          azimuth: "",
          apparentAltitude: "",
          terrestrialRefraction: "",
          heights: "",
          rates: "",
          heightRef: "default" as const,
          targetHeightRef: "ellipsoid" as const,
          terrestrialRefractionK: 0.13,
          refraction: { model: "", temperatureC: 10, pressureHpa: 1010 },
          geoid,
        },
        provenance: prov,
      }),
    )
    .handle("sightline", ({ query }) =>
      Effect.succeed({
        observer: obs(query),
        target: obs({ lat: query.targetLat, lon: query.targetLon, height: query.targetHeight }),
        distanceKm: 1,
        azimuth: 0,
        samples: query.samples ?? 101,
        profile: [],
        obstacles: [],
        conventions: {
          definition: "",
          terrestrialRefraction: "",
          obstacles: "",
          heights: "",
          terrestrialRefractionK: 0.13,
          geoid,
        },
        provenance: prov,
      }),
    )
    .handle("track", ({ query }) =>
      Effect.succeed({
        start: query.start,
        end: query.end,
        stepSeconds: query.stepSeconds ?? 1200,
        count: 1,
        observer: obs(query),
        sun: { azimuth: [1], altitude: [2], apparentAltitude: [null] },
        moon: { azimuth: [3], altitude: [4], apparentAltitude: [4.2] },
        conventions: { refraction: posConv.refraction, horizon, geoid },
        provenance: prov,
      }),
    ),
)
const Earth = HttpApiBuilder.group(EphemApi, "earth", (h) =>
  h
    .handle("magnetic", ({ query }) =>
      Effect.succeed({
        time: "2026-10-28T11:51:00Z",
        observer: obs(query),
        magnetic: {
          model: "WMM2025" as const,
          declination: -12.5,
          inclination: 66,
          horizontalIntensityNt: 2e4,
          totalIntensityNt: 5e4,
          decimalYear: 2026.8,
          inValidityWindow: true,
          compass: "ok" as const,
        },
        conventions: { model: "", declination: "", compass: "", height: "", geoid },
        provenance: prov,
      }),
    )
    .handle("weather", ({ query }) =>
      Effect.succeed({
        time: "2026-10-28T11:51:00Z",
        observer: { lat: query.lat, lon: query.lon, magneticDeclination: -12.5 },
        stations: [],
        feed: {
          source: "stub",
          fetchedAt: "2026-10-28T11:51:00Z",
          ageSeconds: query.count ?? 1,
          lastModified: null,
          upstreamAgeSeconds: null,
          stale: false,
          tier: "hit" as const,
          stations: 0,
        },
        conventions: { definition: "", distance: "", bearing: "", magneticDeclination: "" },
        provenance: prov,
      }),
    ),
)
const searchConv = {
  definition: "",
  region: "",
  segments: "",
  passes: "",
  candidates: "",
  windows: "",
  filters: "",
  azimuth: "",
  terrestrialRefraction: "",
  heights: "",
  heightRef: "default" as const,
  targetHeightRef: "ellipsoid" as const,
  terrestrialRefractionK: 0.13,
  refraction: { model: "", temperatureC: 10, pressureHpa: 1010 },
  geoid,
}
const geometry = {
  reference: { lat: 0, lon: 0 },
  distanceM: { min: 1, max: 2 },
  elevation: { min: 0, max: 1 },
  azimuth: { min: 0, max: 1 },
  band: { trueAltitudeMin: 0, trueAltitudeMax: 1, azimuthMin: 0, azimuthMax: 1 },
  margins: { altitude: 0, azimuth: 0 },
  maxDistanceKm: 1,
  referenceSpreadM: 1,
}
const regionInfo = {
  encoding: "r1.x",
  polygons: 1,
  rings: 1,
  vertices: 4,
  bbox: [0, 0, 1, 1] as const,
  geoidUndulation: { min: 0, max: 0 },
}
const Search = HttpApiBuilder.group(EphemApi, "search", (h) =>
  h
    .handle("search", ({ payload }) =>
      Effect.succeed({
        body: payload.body,
        start: payload.start,
        end: payload.end,
        target: obs({ lat: payload.targetLat, lon: payload.targetLon, height: payload.targetHeight }),
        observer: { height: payload.height ?? 0, heightRef: "default" as const },
        region: { ...regionInfo, vertices: Array.isArray(payload.region) ? 4 : 0 },
        passes: [],
        search: { geometry, windows: [], passesBeforeFilters: 0, counters: {} },
        conventions: searchConv,
        provenance: prov,
      }),
    )
    .handle("searchWindow", ({ query }) =>
      Effect.succeed({
        body: query.body,
        start: query.start,
        end: query.start,
        target: obs({ lat: query.targetLat, lon: query.targetLon }),
        observer: { height: 0, heightRef: "default" as const },
        region: { ...regionInfo, encoding: query.region },
        passes: [],
        geometry,
        counters: {},
        conventions: searchConv,
        provenance: prov,
      }),
    ),
)
const Meta = HttpApiBuilder.group(EphemApi, "meta", (h) =>
  h.handle("health", () => Effect.succeed({ ok: true as const, implementation: "stub", version: "0" })),
)
const Platform = Layer.mergeAll(HttpPlatform.layer, FileSystem.layerNoop({}), Path.layer, Etag.layerWeak).pipe(
  Layer.provideMerge(FileSystem.layerNoop({})),
)
const App = HttpApiBuilder.layer(EphemApi, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide([Sky, Search, Earth, Meta]),
  Layer.provide(Platform),
)
const { handler } = HttpRouter.toWebHandler(App, { disableLogger: true })
const get = (p: string) => handler(new Request("http://x" + p))
const post = (p: string, body: unknown) =>
  handler(
    new Request("http://x" + p, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  )
const searchBody = {
  body: "moon",
  targetLat: 40.68925,
  targetLon: -74.0445,
  targetHeight: 70,
  targetHeightRef: "msl",
  region: [-74.004, 40.6918, -73.986, 40.7052],
  height: 5,
  heightRef: "msl",
  start: "2026-11-16T00:00:00Z",
  end: "2026-11-18T00:00:00Z",
}

describe("contract", () => {
  it("decodes numeric query params and applies defaults", async () => {
    const r = await get("/v1/position?lat=40.7127&lon=-74.0059&time=2026-10-28T11:51:00Z")
    expect(r.status).toBe(200)
    const j = (await r.json()) as any
    expect(j.observer).toMatchObject({ lat: 40.7127, lon: -74.0059, height: 0 })
  })
  it("rejects out-of-range latitude and malformed time", async () => {
    expect((await get("/v1/position?lat=91&lon=0&time=2026-10-28T11:51:00Z")).status).toBe(400)
    expect((await get("/v1/position?lat=0&lon=0&time=2026-10-28 11:51")).status).toBe(400)
  })
  it("weather: n is an integer 1..10", async () => {
    expect(((await (await get("/v1/weather?lat=40.7&lon=-74&count=3")).json()) as any).feed.ageSeconds).toBe(3)
    expect((await get("/v1/weather?lat=40.7&lon=-74&count=11")).status).toBe(400)
    expect((await get("/v1/weather?lat=40.7&lon=-74&count=1.5")).status).toBe(400)
  })
  it("track: start/end are UTC instants, stepSeconds an integer 60..3600, apparentAltitude may be null", async () => {
    const r = await get(
      "/v1/track?lat=40.7&lon=-74&start=2026-10-28T12:00:00Z&end=2026-10-28T12:00:00Z&stepSeconds=600",
    )
    expect(r.status).toBe(200)
    expect((await r.json()) as any).toMatchObject({ stepSeconds: 600, sun: { apparentAltitude: [null] } })
    for (const bad of ["stepSeconds=59", "stepSeconds=3601", "stepSeconds=90.5"])
      expect(
        (await get(`/v1/track?lat=40.7&lon=-74&start=2026-10-28T12:00:00Z&end=2026-10-28T13:00:00Z&${bad}`)).status,
        bad,
      ).toBe(400)
    expect((await get("/v1/track?lat=40.7&lon=-74&start=2026-10-28 12:00&end=2026-10-28T13:00:00Z")).status).toBe(400)
    expect((await get("/v1/track?lat=40.7&lon=-74&start=2026-10-28T12:00:00Z")).status).toBe(400)
  })
  it("search: JSON body with a bbox or GeoJSON region; unknown fields and bad regions are 400", async () => {
    const r = await post("/v1/alignment/search", searchBody)
    expect(r.status).toBe(200)
    expect(((await r.json()) as any).region.vertices).toBe(4)
    const poly = {
      type: "Feature",
      properties: { name: "x" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-74, 40.7],
            [-73.99, 40.7],
            [-73.99, 40.71],
            [-74, 40.7],
          ],
        ],
      },
    }
    expect(
      (
        await post("/v1/alignment/search", {
          ...searchBody,
          region: poly,
          include: "sun,phase",
          minIlluminated: 0.1,
          maxSunAltitude: -4,
        })
      ).status,
    ).toBe(200)
    expect((await post("/v1/alignment/search", { ...searchBody, bogus: 1 })).status).toBe(400)
    expect((await post("/v1/alignment/search", { ...searchBody, region: [1, 2, 3] })).status).toBe(400)
    expect(
      (
        await post("/v1/alignment/search", {
          ...searchBody,
          region: {
            type: "LineString",
            coordinates: [
              [0, 0],
              [1, 1],
            ],
          },
        })
      ).status,
    ).toBe(400)
    expect((await post("/v1/alignment/search", { ...searchBody, include: "moon" })).status).toBe(400)
    expect((await post("/v1/alignment/search", { ...searchBody, minIlluminated: 2 })).status).toBe(400)
  })
  it("search window: a GET with the r1 region encoding", async () => {
    expect(
      (
        await get(
          "/internal/alignment-search-window?body=moon&targetLat=40.68925&targetLon=-74.0445&targetHeight=37&region=r1.AbC_-&start=2026-10-17T00:00:00Z",
        )
      ).status,
    ).toBe(200)
    expect(
      (
        await get(
          "/internal/alignment-search-window?body=moon&targetLat=40.68925&targetLon=-74.0445&targetHeight=37&region=nope&start=2026-10-17T00:00:00Z",
        )
      ).status,
    ).toBe(400)
  })
  it("serves OpenAPI", async () => {
    const spec = OpenApi.fromApi(EphemApi) as any
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        "/v1/position",
        "/v1/day",
        "/v1/alignment",
        "/v1/track",
        "/v1/weather",
        "/v1/magnetic",
        "/v1/alignment/search",
      ]),
    )
    expect(Object.keys(spec.paths)).not.toContain("/internal/alignment-search-window") // internal: the Api's cache unit
    expect(spec.paths["/v1/alignment/search"].post.requestBody).toBeDefined()
  })
})
