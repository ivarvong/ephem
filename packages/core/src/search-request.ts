// /internal/alignment-search-window at the request level: resolve heights (as /alignment), run one 30-day window of the search,
// and state every convention. Output = the @ephem/api SearchWindowResponse minus provenance.
import type { BlockSource, BodyName } from "./ephemeris.ts"
import { ALIGNMENT_CONVENTIONS, alignmentLatRange } from "./alignment-request.ts"
import { type HeightRef, K_TERRESTRIAL, P_DEFAULT, T_DEFAULT } from "./horizon.ts"
import { GEOID, geoidUndulation } from "./geoid.ts"
import { REFRACTION_MODEL } from "./sky.ts"
import { type Region, regionBbox, regionVertices } from "./region.ts"
import { SEARCH, WINDOW_MS, searchWindow } from "./search.ts"
import { isoMs } from "./time.ts"
import { type Aim, AIM_DEFINITIONS } from "./aim.ts"

export interface SearchWindowRequest {
  readonly body: BodyName
  readonly targetLat: number; readonly targetLon: number; readonly targetHeight: number; readonly targetHeightRef?: HeightRef | undefined
  readonly height?: number | undefined; readonly heightRef?: HeightRef | undefined
  readonly region: Region; readonly encoding: string
  readonly startMs: number   // on the window grid
  readonly temperature?: number | undefined; readonly pressure?: number | undefined; readonly dut1?: number | undefined
  readonly aim?: Aim | undefined   // default center; litCentroid only for the Moon
}

export const SEARCH_CONVENTIONS = {
  definition: "A pass: the alignment standing point P(t) of /alignment (same solver, same definition: the body's azimuth at P = the forward azimuth P → target, its apparent altitude = the target's apparent elevation from P) lies inside the region. Segments are the in-region intervals of the ground track; passes group segments.",
  region: "GeoJSON (RFC 7946) Polygon or MultiPolygon with holes, or a bbox; edges are straight lines in (lon, lat); inside = even-odd per polygon, any polygon of a MultiPolygon. Coordinates are quantised to 1e-7° (≤ 1.1 cm), rings re-oriented (RFC 7946 right-hand rule) and re-started at their smallest vertex: region.encoding is that canonical form.",
  segments: `enter / exit: the instant the ground track crosses a region edge, solved on the exact track (every evaluation a full standing-point solve) to ${SEARCH.crossingTolM * 1000} mm along the edge's normal (≈ 0.1 ms at the 12 m/s typical of a moonset 4 km out), not sampled. The track between crossings is followed with chords ≤ ${SEARCH.chordM} m, bisected wherever it bends more than ${SEARCH.sagittaM * 100} cm off a chord; incursions shallower than that may be missed. Segments touching within 1 ms are merged; shorter than 1 ms are dropped.`,
  passes: `Segments less than ${SEARCH.passGapS / 60} min apart form one pass. A pass is reported when its first entry lies in [start, end). Its time is the midpoint of its first entry and last exit; standingPoint, moon (azimuth, apparent altitude, illuminated fraction, angular radius), sunAlt (the Sun centre's true altitude) and include=sun,phase are evaluated at that instant from that standing point.`,
  candidates: "No representative observer elevation (with aim other than center, the band widens by 0.3°, more than any disc radius): the body must be inside the band the whole region allows, i.e. apparent altitude in [elevation.min, elevation.max] (the target's apparent elevation at the region's farthest and nearest points; the target must be above the eye) and azimuth in the region's range of bearings to the target; seen from the reference point (the region's centre) that band widens by the tilt of the vertical across the region (s/R), parallax and meridian convergence (geometry.margins). The scan is complete: seen from the reference point (latitude φ) the body's true altitude changes by < ω·cos φ + 1°/h and its azimuth by < ω·(|sin φ| + cos φ·tan H) + 1°/h ÷ cos H while |altitude| ≤ H (ω = 15.0411°/h; the 1°/h is the body's own motion, diurnal parallax included), so wherever the altitude or azimuth is d from the band the scan may skip d over that rate; near the band it steps 60 s keeping every step whose two ends could both reach the band within it, then pulls each kept span's ends in by the same skips. Every instant with the standing point inside the region lies in a kept span; counters.anomalies counts any span end found inside (0 expected).",
  windows: `The search runs per ${SEARCH.windowDays}-day window on a fixed UTC grid (multiples of ${SEARCH.windowDays} days since 1970-01-01T00:00Z), each a pure function of the request: GET /internal/alignment-search-window, immutable in Workers Caching, so repeated and overlapping scans recompute nothing. A window scans ${SEARCH.lookbackS / 3600} h before and ${SEARCH.lookaheadS / 3600} h after itself so passes crossing its edges are whole and owned by exactly one window.`,
  filters: "minIlluminated and maxSunAltitude apply to each pass's values at its time, after the windows (cached answers are unfiltered). include=sun adds the Sun's azimuth and true / apparent altitude, include=phase the Moon's phase block (as /position).",
  azimuth: ALIGNMENT_CONVENTIONS.azimuth,
  terrestrialRefraction: ALIGNMENT_CONVENTIONS.terrestrialRefraction,
  heights: ALIGNMENT_CONVENTIONS.heights,
} as const

/** The latitude range whose geoid bands a window reads: the region, and every standing point the solver may try (within
 *  SEARCH.maxDistanceKm + 1 of the target). */
export const searchLatRange = (region: Region, targetLat: number): [number, number] => {
  const b = regionBbox(region), [lo, hi] = alignmentLatRange(targetLat, SEARCH.maxDistanceKm + 1)
  return [Math.min(b.south, lo), Math.max(b.north, hi)]
}

export const searchWindowRequest = (src: BlockSource, q: SearchWindowRequest) => {
  if (q.aim === "litCentroid" && q.body !== "moon") return { error: "aim=litCentroid is the Moon's lit-area centroid: body must be moon" }
  const T = q.temperature ?? T_DEFAULT, P = q.pressure ?? P_DEFAULT
  const tN = geoidUndulation(q.targetLat, q.targetLon), tRef = q.targetHeightRef ?? "ellipsoid"
  const tE = tRef === "msl" ? q.targetHeight + tN : q.targetHeight
  const oRef: HeightRef | "default" = q.height === undefined ? "default" : q.heightRef ?? "ellipsoid"
  const r = searchWindow(src, {
    body: q.body, target: { lat: q.targetLat, lon: q.targetLon, height: tE },
    observerHeight: q.height ?? 0, observerHeightRef: oRef === "ellipsoid" ? "ellipsoid" : "msl",
    region: q.region, startMs: q.startMs, endMs: q.startMs + WINDOW_MS, temperature: T, pressure: P, dut1: q.dut1, aim: q.aim,
  })
  if ("error" in r) return { error: r.error }
  const b = regionBbox(q.region), verts = regionVertices(q.region), Ns = verts.map(([lon, lat]) => geoidUndulation(lat, lon))
  return {
    ok: {
      body: q.body, start: isoMs(q.startMs), end: isoMs(q.startMs + WINDOW_MS),
      target: { lat: q.targetLat, lon: q.targetLon, height: tE, heightEllipsoid: tE, heightMsl: tE - tN, geoidUndulation: tN, heightRef: tRef },
      observer: { height: q.height ?? 0, heightRef: oRef },
      region: {
        encoding: q.encoding, polygons: q.region.length, rings: q.region.reduce((s, p) => s + p.length, 0), vertices: verts.length,
        bbox: [b.west, b.south, b.east, b.north] as const, geoidUndulation: { min: Math.min(...Ns), max: Math.max(...Ns) },
      },
      passes: r.passes,
      geometry: r.geometry,
      counters: r.counters as unknown as Record<string, number>,
      conventions: {
        ...SEARCH_CONVENTIONS,
        heightRef: oRef, targetHeightRef: tRef,
        terrestrialRefractionK: K_TERRESTRIAL,
        refraction: { model: REFRACTION_MODEL, temperatureC: T, pressureHpa: P },
        geoid: { model: GEOID.model, source: GEOID.source, interpolationErrorM: GEOID.interpolationErrorM },
        ...(q.aim !== undefined ? { aim: { point: q.aim, definition: AIM_DEFINITIONS[q.aim] } } : {}),
      },
    },
  }
}
