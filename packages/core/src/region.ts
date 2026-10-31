// Standing regions for /alignment/search: a GeoJSON Polygon / MultiPolygon (RFC 7946, holes allowed) or a bbox, validated,
// canonicalised and encoded into one URL-safe string (the cacheable window GET carries it), plus the planar geometry the search
// clips against.
//
// Edges are straight lines in (lon, lat), as RFC 7946 §3.1.1 defines them. The search works in an affine image of (lon, lat)
// (x = Δlon·m_lon, y = Δlat·m_lat at the region's centre): an affine map keeps straight lines straight, so insideness and edge
// crossings are exactly those of the GeoJSON; the metre scale is used only for tolerances.
import { DEG } from "./linalg.ts"
import { WGS84 } from "./observe.ts"

export type Position = readonly [number, number]   // [lon, lat], degrees
export type Ring = ReadonlyArray<Position>          // open (no repeated closing vertex), canonical orientation and start
export type Polygon = ReadonlyArray<Ring>           // [outer, ...holes]
export type Region = ReadonlyArray<Polygon>

/** Coordinates are quantised to 1e-7° (≤ 1.1 cm), so equal regions give equal cache keys. */
export const REGION_QUANTUM_DEG = 1e-7
export const REGION_LIMITS = { maxVertices: 1000, maxRings: 100, maxExtentKm: 50 } as const
const Q = 1e7

export type RegionResult = { readonly ok: Region } | { readonly error: string }

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x)
const q = (x: number) => Math.round(x * Q)
/** Twice the signed area in quantum units (shoelace on (lon, lat)): > 0 counter-clockwise. */
const area2 = (r: ReadonlyArray<readonly [number, number]>) => {
  let s = 0
  for (let i = 0; i < r.length; i++) { const a = r[i]!, b = r[(i + 1) % r.length]!; s += a[0] * b[1] - b[0] * a[1] }
  return s
}
const lexLess = (a: readonly [number, number], b: readonly [number, number]) => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1])

/** One ring → quantised integer vertices: closing vertex and repeats dropped, outer counter-clockwise and holes clockwise
 *  (RFC 7946 right-hand rule), starting at its smallest (lon, lat) vertex. */
const canonRing = (raw: unknown, hole: boolean, where: string): Array<[number, number]> | string => {
  if (!Array.isArray(raw)) return `${where}: a ring must be an array of [lon, lat] positions`
  const pts: Array<[number, number]> = []
  for (const p of raw) {
    if (!Array.isArray(p) || p.length < 2 || !isNum(p[0]) || !isNum(p[1])) return `${where}: every position must be [lon, lat] numbers`
    if (p[0] < -180 || p[0] > 180 || p[1] < -90 || p[1] > 90) return `${where}: position [${p[0]}, ${p[1]}] is outside [-180, 180] × [-90, 90]`
    const v: [number, number] = [q(p[0]), q(p[1])], last = pts[pts.length - 1]
    if (!last || last[0] !== v[0] || last[1] !== v[1]) pts.push(v)
  }
  if (pts.length > 1 && pts[0]![0] === pts[pts.length - 1]![0] && pts[0]![1] === pts[pts.length - 1]![1]) pts.pop()
  if (pts.length < 3) return `${where}: a ring needs at least 3 distinct positions`
  const a = area2(pts)
  if (a === 0) return `${where}: the ring has zero area`
  if ((a < 0) !== hole) pts.reverse()
  let k = 0
  for (let i = 1; i < pts.length; i++) if (lexLess(pts[i]!, pts[k]!)) k = i
  return [...pts.slice(k), ...pts.slice(0, k)]
}

type IntPolygon = Array<Array<[number, number]>>
const canonPolygon = (raw: unknown, where: string): IntPolygon | string => {
  if (!Array.isArray(raw) || raw.length === 0) return `${where}: a polygon is a non-empty array of rings`
  const rings: IntPolygon = []
  for (let i = 0; i < raw.length; i++) {
    const r = canonRing(raw[i], i > 0, `${where} ring ${i}`)
    if (typeof r === "string") return r
    rings.push(r)
  }
  const [outer, ...holes] = rings
  holes.sort((a, b) => (lexLess(a[0]!, b[0]!) ? -1 : 1))
  return [outer!, ...holes]
}

/** Accepts a GeoJSON Polygon or MultiPolygon geometry, a Feature with one, or a bbox [west, south, east, north]. */
export const parseRegion = (input: unknown): RegionResult => {
  let polys: IntPolygon[] = []
  const g = input as { type?: unknown; coordinates?: unknown; geometry?: unknown }
  if (Array.isArray(input)) {
    if (input.length !== 4 || !input.every(isNum)) return { error: "region: a bbox is [west, south, east, north] (4 numbers)" }
    const [w, s, e, n] = input as number[]
    if (!(w! < e! && s! < n!)) return { error: "region: bbox needs west < east and south < north (no antimeridian crossing)" }
    const r = canonPolygon([[[w, s], [e, s], [e, n], [w, n]]], "region bbox")
    if (typeof r === "string") return { error: r }
    polys = [r]
  } else if (g && typeof g === "object" && g.type === "Feature") {
    return parseRegion(g.geometry)
  } else if (g && typeof g === "object" && g.type === "Polygon") {
    const r = canonPolygon(g.coordinates, "region")
    if (typeof r === "string") return { error: r }
    polys = [r]
  } else if (g && typeof g === "object" && g.type === "MultiPolygon") {
    if (!Array.isArray(g.coordinates) || g.coordinates.length === 0) return { error: "region: MultiPolygon coordinates must be a non-empty array of polygons" }
    for (let i = 0; i < g.coordinates.length; i++) {
      const r = canonPolygon(g.coordinates[i], `region polygon ${i}`)
      if (typeof r === "string") return { error: r }
      polys.push(r)
    }
    polys.sort((a, b) => (lexLess(a[0]![0]!, b[0]![0]!) ? -1 : 1))
  } else {
    return { error: "region: expected a GeoJSON Polygon or MultiPolygon (geometry or Feature) or a bbox [west, south, east, north]" }
  }
  const rings = polys.reduce((s, p) => s + p.length, 0), verts = polys.reduce((s, p) => s + p.reduce((t, r) => t + r.length, 0), 0)
  if (rings > REGION_LIMITS.maxRings) return { error: `region: ${rings} rings; at most ${REGION_LIMITS.maxRings}` }
  if (verts > REGION_LIMITS.maxVertices) return { error: `region: ${verts} vertices; at most ${REGION_LIMITS.maxVertices}` }
  const region: Region = polys.map(p => p.map(r => r.map(([x, y]) => [x / Q, y / Q] as const)))
  const b = regionBbox(region)
  if (b.east - b.west > 180) return { error: "region: crosses the antimeridian or spans more than 180° of longitude" }
  const f = planarFrame(region), ext = Math.hypot((b.east - b.west) * f.mx, (b.north - b.south) * f.my) / 1000
  if (ext > REGION_LIMITS.maxExtentKm) return { error: `region: ${ext.toFixed(1)} km across (bbox diagonal); at most ${REGION_LIMITS.maxExtentKm} km` }
  return { ok: region }
}

// ─────────────── canonical encoding: "r1." + base64url(varints) ───────────────
// Varints: polygons, then per polygon its ring count, per ring its vertex count, then every vertex as zigzag deltas (lon, lat)
// in 1e-7° from the previous vertex (the first from 0, 0). Decoding re-canonicalises and must reproduce the same string,
// so a cache key names exactly one region.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
const pushVarint = (out: number[], z: number) => { while (z >= 128) { out.push((z % 128) + 128); z = Math.floor(z / 128) } out.push(z) }
const zig = (n: number) => (n >= 0 ? 2 * n : -2 * n - 1)
const unzig = (z: number) => (z % 2 ? -(z + 1) / 2 : z / 2)
export const encodeRegion = (region: Region): string => {
  const out: number[] = []
  pushVarint(out, region.length)
  for (const p of region) { pushVarint(out, p.length); for (const r of p) pushVarint(out, r.length) }
  let px = 0, py = 0
  for (const p of region) for (const r of p) for (const [lon, lat] of r) {
    const x = q(lon), y = q(lat); pushVarint(out, zig(x - px)); pushVarint(out, zig(y - py)); px = x; py = y
  }
  let s = ""
  for (let i = 0; i < out.length; i += 3) {
    const n = (out[i]! << 16) | ((out[i + 1] ?? 0) << 8) | (out[i + 2] ?? 0), k = Math.min(3, out.length - i)
    s += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + (k > 1 ? B64[(n >> 6) & 63]! : "") + (k > 2 ? B64[n & 63]! : "")
  }
  return `r1.${s}`
}
export const decodeRegion = (s: string): RegionResult => {
  if (!s.startsWith("r1.")) return { error: "region: not an r1. encoding" }
  const body = s.slice(3), bytes: number[] = []
  let acc = 0, bits = 0
  for (const ch of body) {
    const v = B64.indexOf(ch); if (v < 0) return { error: "region: invalid character in encoding" }
    acc = (acc << 6) | v; bits += 6
    if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 255) }
  }
  let p = 0
  const read = (): number => {
    let z = 0, m = 1
    for (;;) { if (p >= bytes.length) throw new RangeError("truncated"); const c = bytes[p++]!; z += (c % 128) * m; if (c < 128) return z; m *= 128 }
  }
  try {
    const np = read(), shape: number[][] = []
    if (np < 1 || np > REGION_LIMITS.maxRings) return { error: "region: bad polygon count" }
    for (let i = 0; i < np; i++) { const nr = read(); if (nr < 1 || nr > REGION_LIMITS.maxRings) return { error: "region: bad ring count" }; shape.push([]) ; for (let j = 0; j < nr; j++) shape[i]!.push(read()) }
    let px = 0, py = 0, total = 0
    const polys = shape.map(rs => rs.map(n => {
      total += n; if (total > REGION_LIMITS.maxVertices) throw new RangeError("too many vertices")
      return Array.from({ length: n }, () => { px += unzig(read()); py += unzig(read()); return [px / Q, py / Q] })
    }))
    if (p !== bytes.length) return { error: "region: trailing bytes in encoding" }
    const r = parseRegion({ type: "MultiPolygon", coordinates: polys })
    if ("error" in r) return r
    if (encodeRegion(r.ok) !== s) return { error: "region: encoding is not canonical (re-encode the region with the API's canonical form)" }
    return r
  } catch (e) { return { error: `region: invalid encoding (${e instanceof Error ? e.message : String(e)})` } }
}

// ─────────────── geometry ───────────────
export const regionBbox = (region: Region) => {
  let west = Infinity, east = -Infinity, south = Infinity, north = -Infinity
  for (const p of region) for (const [lon, lat] of p[0]!) { west = Math.min(west, lon); east = Math.max(east, lon); south = Math.min(south, lat); north = Math.max(north, lat) }
  return { west, east, south, north }
}
export const regionVertices = (region: Region): Position[] => region.flatMap(p => p.flatMap(r => r))

/** Metres per degree of latitude (meridian) and longitude at geodetic latitude φ on WGS-84. */
export const metresPerDegree = (lat: number) => {
  const e2 = WGS84.f * (2 - WGS84.f), s = Math.sin(lat * DEG), w = Math.sqrt(1 - e2 * s * s), a = WGS84.a * 1000
  return { my: a * (1 - e2) / (w * w * w) * DEG, mx: a / w * Math.cos(lat * DEG) * DEG }
}

export interface PlanarFrame {
  readonly lon0: number; readonly lat0: number; readonly mx: number; readonly my: number
  readonly toXY: (lon: number, lat: number) => readonly [number, number]
}
/** Affine image of (lon, lat) around the region's bbox centre, in approximate metres. */
export const planarFrame = (region: Region): PlanarFrame => {
  const b = regionBbox(region), lon0 = (b.west + b.east) / 2, lat0 = (b.south + b.north) / 2, { mx, my } = metresPerDegree(lat0)
  return { lon0, lat0, mx, my, toXY: (lon, lat) => [(((lon - lon0 + 540) % 360) - 180) * mx, (lat - lat0) * my] }
}

/** The region's edges in a planar frame, flattened: [ax, ay, bx, by] per edge, plus per polygon its edge range (even-odd). */
export interface PlanarRegion {
  readonly frame: PlanarFrame
  readonly edges: Float64Array
  readonly polygons: ReadonlyArray<{ readonly from: number; readonly to: number; readonly minX: number; readonly maxX: number; readonly minY: number; readonly maxY: number }>
}
export const planarRegion = (region: Region, frame: PlanarFrame = planarFrame(region)): PlanarRegion => {
  const e: number[] = [], polygons: Array<PlanarRegion["polygons"][number]> = []
  for (const p of region) {
    const from = e.length / 4
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (const r of p) for (let i = 0; i < r.length; i++) {
      const [ax, ay] = frame.toXY(r[i]![0], r[i]![1]), [bx, by] = frame.toXY(r[(i + 1) % r.length]![0], r[(i + 1) % r.length]![1])
      e.push(ax, ay, bx, by)
      minX = Math.min(minX, ax); maxX = Math.max(maxX, ax); minY = Math.min(minY, ay); maxY = Math.max(maxY, ay)
    }
    polygons.push({ from, to: e.length / 4, minX, maxX, minY, maxY })
  }
  return { frame, edges: Float64Array.from(e), polygons }
}
/** Even-odd ray test per polygon (outer ring and holes together); inside the region = inside any polygon. */
export const insidePlanar = (pr: PlanarRegion, x: number, y: number): boolean => {
  const E = pr.edges
  for (const p of pr.polygons) {
    if (x < p.minX || x > p.maxX || y < p.minY || y > p.maxY) continue
    let inside = false
    for (let k = p.from; k < p.to; k++) {
      const ax = E[4 * k]!, ay = E[4 * k + 1]!, bx = E[4 * k + 2]!, by = E[4 * k + 3]!
      if ((ay > y) !== (by > y) && x < ax + (y - ay) * (bx - ax) / (by - ay)) inside = !inside
    }
    if (inside) return true
  }
  return false
}
export const insideRegion = (pr: PlanarRegion, lon: number, lat: number): boolean => { const [x, y] = pr.frame.toXY(lon, lat); return insidePlanar(pr, x, y) }
