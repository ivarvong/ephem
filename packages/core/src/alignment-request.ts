// /v1/alignment at the request level: resolve the observer's and the target's height references (EGM96), run the solver,
// add per-point rates and heights, and state every convention used. Output = the @ephem/api response minus provenance.
import type { BlockSource, BodyName } from "./ephemeris.ts"
import { type AlignmentInput, alignment, ratesAt } from "./alignment.ts"
import { type HeightRef, K_TERRESTRIAL, P_DEFAULT, R_MEAN_M, T_DEFAULT } from "./horizon.ts"
import { GEOID, geoidUndulation, observerHeights } from "./geoid.ts"
import { RATE_METHOD } from "./position.ts"
import { REFRACTION_MODEL } from "./sky.ts"
import { CONTEXT_CONVENTIONS, type Include, contextAt } from "./context.ts"
import { type Aim, AIM_DEFINITIONS } from "./aim.ts"

export interface AlignmentRequest {
  readonly body: BodyName
  readonly targetLat: number
  readonly targetLon: number
  readonly targetHeight: number
  readonly targetHeightRef?: HeightRef | undefined // default ellipsoid (as `height` everywhere)
  readonly height?: number | undefined // default: the eye on the geoid (heightMsl 0), as every endpoint
  readonly heightRef?: HeightRef | undefined // what height is measured from; default ellipsoid
  readonly startMs: number
  readonly endMs: number
  readonly stepSeconds: number
  readonly maxDistanceKm: number
  readonly temperature?: number | undefined
  readonly pressure?: number | undefined
  readonly dut1?: number | undefined
  readonly observer?: { readonly lat: number; readonly lon: number } | undefined
  readonly include?: ReadonlySet<Include> | undefined // sun, phase: context per track point and per pass
  readonly aim?: Aim | undefined // default center; litCentroid only for the Moon (the caller checks)
}

export const ALIGNMENT_CONVENTIONS = {
  definition:
    "Standing point P (at the eye height) solves, at each instant: (1) the body's azimuth seen from P = the forward geodesic azimuth P → target, and (2) the body's apparent altitude seen from P = the target's apparent elevation from P. Solved to 1e-7° in both; points are omitted when the body is below −1° (true) or no P lies within maxDistanceKm.",
  azimuth:
    "track[].azimuth: the body's azimuth seen from that standing point, degrees from true north through east, [0, 360). By construction it equals the forward geodesic (WGS-84) azimuth from the standing point to the target.",
  apparentAltitude:
    "track[].apparentAltitude: the body's apparent (refracted) altitude seen from the standing point = the target's apparent elevation from there, degrees. With aim, azimuth and apparentAltitude are the aim point's.",
  terrestrialRefraction: `Modelled, as a constant coefficient: the target's apparent elevation = its geometric elevation (exact WGS-84 ECEF vectors, eye to target) + k·θ/2, k = ${K_TERRESTRIAL}, θ = geodesic distance / ${R_MEAN_M} m (the sight line is an arc of curvature k/R). No atmospheric profile, inversion or ducting; real k near the ground varies roughly 0–0.3 with the temperature gradient, which moves the elevation by about ±k·θ/2 (±0.005° at 4 km).`,
  heights:
    "height (the eye, wherever you stand) and targetHeight are metres above the WGS-84 ellipsoid by default; heightRef=msl / targetHeightRef=msl make them metres above the EGM96 geoid (≈ mean sea level). With heightRef=msl the eye's ellipsoidal height is height + N at every standing point (N varies along the track). Without height the eye is on the geoid (heightMsl 0), as on every other endpoint. Each track point gives heightEllipsoid, heightMsl and geoidUndulation N (heightEllipsoid = heightMsl + N).",
  rates: `altitudeRate, azimuthRate: degrees per minute, d(true altitude)/dt and d(azimuth)/dt of the body seen from the (fixed) standing point; ${RATE_METHOD}, as /v1/position.`,
} as const

const heightsOut = (lat: number, lon: number, hE: number) => {
  const N = geoidUndulation(lat, lon)
  return { heightEllipsoid: hE, heightMsl: hE - N, geoidUndulation: N }
}

/** The latitude band alignment's standing points can reach (for prefetching geoid bands): target ± maxDistance, padded. */
export const alignmentLatRange = (targetLat: number, maxDistanceKm: number): [number, number] => {
  const d = maxDistanceKm / 110.5 + 0.01
  return [Math.max(-90, targetLat - d), Math.min(90, targetLat + d)]
}

export const alignmentRequest = (src: BlockSource, q: AlignmentRequest) => {
  const T = q.temperature ?? T_DEFAULT,
    P = q.pressure ?? P_DEFAULT
  const tN = geoidUndulation(q.targetLat, q.targetLon),
    tRef = q.targetHeightRef ?? "ellipsoid"
  const tE = tRef === "msl" ? q.targetHeight + tN : q.targetHeight
  const oRef: HeightRef | "default" = q.height === undefined ? "default" : (q.heightRef ?? "ellipsoid")
  const inp: AlignmentInput = {
    body: q.body,
    target: { lat: q.targetLat, lon: q.targetLon, height: tE },
    observerHeight: q.height ?? 0,
    observerHeightRef: oRef === "ellipsoid" ? "ellipsoid" : "msl",
    startMs: q.startMs,
    endMs: q.endMs,
    stepSeconds: q.stepSeconds,
    maxDistanceKm: q.maxDistanceKm,
    temperature: T,
    pressure: P,
    dut1: q.dut1,
    observer: q.observer,
    aim: q.aim,
  }
  const aimed = q.aim !== undefined && q.aim !== "center"
  const r = alignment(src, inp),
    inc = q.include ?? new Set<Include>(),
    ctx = { dut1: q.dut1, temperature: T, pressure: P }
  const track = r.track.map((p) => ({
    time: p.time,
    lat: p.lat,
    lon: p.lon,
    distanceKm: p.distanceKm,
    azimuth: p.azimuth,
    apparentAltitude: p.apparentAltitude,
    angularRadius: p.angularRadius,
    ...ratesAt(src, q.body, { lat: p.lat, lon: p.lon, height: p.heightEllipsoid }, Date.parse(p.time), q.dut1 ?? 0),
    ...heightsOut(p.lat, p.lon, p.heightEllipsoid),
    ...(aimed ? { aimOffset: p.aimOffset, aimAngle: p.aimAngle } : {}),
    ...contextAt(
      src,
      inc,
      { lat: p.lat, lon: p.lon, height: p.heightEllipsoid },
      p.heightEllipsoid - geoidUndulation(p.lat, p.lon),
      Date.parse(p.time),
      ctx,
    ),
    iterations: p.iterations,
  }))
  let fromObserver
  if (r.fromObserver && q.observer) {
    const h = observerHeights(q.observer.lat, q.observer.lon, q.height, q.heightRef)
    const geo = { lat: q.observer.lat, lon: q.observer.lon, height: h.heightEllipsoid }
    const passes = r.fromObserver.passes.map((x) => ({
      ...x,
      ...contextAt(src, inc, geo, h.heightMsl, Date.parse(x.time), ctx),
    }))
    fromObserver = {
      ...r.fromObserver,
      passes,
      observer: {
        lat: q.observer.lat,
        lon: q.observer.lon,
        height: h.heightEllipsoid,
        heightEllipsoid: h.heightEllipsoid,
        heightMsl: h.heightMsl,
        geoidUndulation: h.geoidUndulation,
        heightRef: h.heightRef,
      },
    }
  }
  return {
    body: r.body,
    target: {
      lat: q.targetLat,
      lon: q.targetLon,
      height: tE,
      heightEllipsoid: tE,
      heightMsl: tE - tN,
      geoidUndulation: tN,
      heightRef: tRef,
    },
    track,
    ...(fromObserver ? { fromObserver } : {}),
    conventions: {
      ...ALIGNMENT_CONVENTIONS,
      ...(inc.size ? { include: CONTEXT_CONVENTIONS } : {}),
      ...(q.aim !== undefined ? { aim: { point: q.aim, definition: AIM_DEFINITIONS[q.aim] } } : {}),
      heightRef: oRef,
      targetHeightRef: tRef,
      terrestrialRefractionK: K_TERRESTRIAL,
      refraction: { model: REFRACTION_MODEL, temperatureC: T, pressureHpa: P },
      geoid: { model: GEOID.model, source: GEOID.source, interpolationErrorM: GEOID.interpolationErrorM },
    },
  }
}
