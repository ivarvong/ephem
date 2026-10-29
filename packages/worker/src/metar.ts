// METARs: aviationweather.gov's all-stations CSV (metars.cache.csv.gz) → a station table with a nearest-station lookup.
// Pure: no I/O. The feed cache (metar-feed.ts) parses once per data version per isolate and hands the table to requests.

/** RFC 4180 CSV: quoted fields, "" escapes, CRLF or LF. Returns rows of raw strings (header included). */
export const parseCsv = (text: string): string[][] => {
  const rows: string[][] = []
  let row: string[] = [], i = 0
  const n = text.length
  while (i < n) {
    let field: string
    if (text.charCodeAt(i) === 34 /* " */) {
      let j = i + 1, out = ""
      for (;;) {
        const q = text.indexOf('"', j)
        if (q < 0) throw new SyntaxError(`unterminated quoted field at offset ${i}`)
        out += text.slice(j, q)
        if (text.charCodeAt(q + 1) === 34) { out += '"'; j = q + 2 } else { j = q + 1; break }
      }
      field = out; i = j
    } else {
      let j = i
      while (j < n) { const c = text.charCodeAt(j); if (c === 44 || c === 10 || c === 13) break; j++ }
      field = text.slice(i, j); i = j
    }
    row.push(field)
    const c = text.charCodeAt(i)
    if (c === 44) { i++; if (i === n) row.push("") }
    else if (c === 13 || c === 10 || i >= n) { rows.push(row); row = []; i += c === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1 }
    else throw new SyntaxError(`unexpected character after quoted field at offset ${i}`)
  }
  if (row.length) rows.push(row)
  return rows
}

export interface SkyLayer { readonly cover: string; readonly baseFtAgl: number | null }
export interface Metar {
  readonly stationId: string
  readonly raw: string
  readonly observationTime: string       // ISO UTC as published
  readonly observationMs: number
  readonly lat: number; readonly lon: number
  readonly elevationM: number | null
  readonly metarType: string | null      // METAR | SPECI
  readonly flightCategory: string | null // VFR | MVFR | IFR | LIFR
  readonly temperatureC: number | null; readonly dewpointC: number | null
  readonly windDirectionDeg: number | null   // ° true, null when calm or variable
  readonly windVariable: boolean
  readonly windSpeedKt: number | null; readonly windGustKt: number | null
  readonly visibilityMi: number | null; readonly visibilityPlus: boolean   // "10+" → 10, plus
  readonly altimeterInHg: number | null; readonly seaLevelPressureMb: number | null
  readonly wx: string | null
  readonly sky: ReadonlyArray<SkyLayer>
  readonly verticalVisibilityFt: number | null
}

const num = (s: string | undefined): number | null => {
  if (s === undefined || s === "" || s === "null") return null
  const x = Number(s); return Number.isFinite(x) ? x : null
}
const str = (s: string | undefined): string | null => (s === undefined || s === "" || s === "null" ? null : s)
/** The wind group of the report body (before RMK): VRB03KT, VRB06G15KT. "VRB" elsewhere (remarks) does not count. */
const VRB = /(?:^|\s)VRB\d{2,3}(?:G\d{2,3})?(?:KT|MPS|KMH)(?:\s|$)/

export class MetarFormatError extends Error { readonly _tag = "MetarFormatError" }

export interface Table {
  /** stations with coordinates */
  readonly count: number
  /** the full parsed record of station i (parsed on first use, then memoised) */
  readonly station: (i: number) => Metar
  readonly stationId: (i: number) => string
  /** unit vectors of the stations, xyz interleaved, for the scan */
  readonly xyz: Float64Array
  readonly skipped: number   // rows without coordinates
}

/**
 * CSV text → table. Columns are found by header name (the feed repeats sky_cover/cloud_base_ft_agl four times).
 * Lazy: per data version only the station id and coordinates are read from each line (indexOf over the first few
 * commas, past the quoted raw_text); a line is fully parsed only when a lookup returns it. Full eager parse of the
 * 2026-10-29 file: 8.0 ms in node; this index: 0.85 ms (scratchpad bench/lazy.ts). A line whose quoting the fast path
 * cannot follow (a quote in a later field, a newline inside quotes) falls back to the full parser.
 */
export const parseMetars = (text: string): Table => {
  const nl = text.indexOf("\n"), headLine = (nl < 0 ? text : text.slice(0, nl)).replace(/\r$/, "")
  const head = parseCsv(headLine)[0]
  if (!head || head[0] !== "raw_text") throw new MetarFormatError(`unexpected header: ${(head ?? []).slice(0, 3).join(",")}`)
  const col = (name: string) => { const i = head.indexOf(name); if (i < 0) throw new MetarFormatError(`missing column ${name}`); return i }
  const C = {
    raw: 0, id: col("station_id"), time: col("observation_time"), lat: col("latitude"), lon: col("longitude"),
    t: col("temp_c"), td: col("dewpoint_c"), wd: col("wind_dir_degrees"), ws: col("wind_speed_kt"), wg: col("wind_gust_kt"),
    vis: col("visibility_statute_mi"), alt: col("altim_in_hg"), slp: col("sea_level_pressure_mb"), wx: col("wx_string"),
    fc: col("flight_category"), type: col("metar_type"), elev: col("elevation_m"), vv: col("vert_vis_ft"),
  }
  const skyCols: Array<[number, number]> = []
  head.forEach((h, i) => { if (h === "sky_cover" && head[i + 1] === "cloud_base_ft_agl") skyCols.push([i, i + 1]) })
  const maxCol = Math.max(C.id, C.lat, C.lon)

  // rows: a line string (fast path) or already-split fields (fallback); ids/lat/lon for those with coordinates
  const rows: Array<string | string[]> = [], ids: string[] = [], lats: number[] = [], lons: number[] = []
  let skipped = 0
  const keep = (row: string | string[], id: string | null, lat: number | null, lon: number | null) => {
    if (lat === null || lon === null || id === null) { skipped++; return }
    rows.push(row); ids.push(id); lats.push(lat); lons.push(lon)
  }
  const slow = (fields: string[]) => keep(fields, str(fields[C.id]), num(fields[C.lat]), num(fields[C.lon]))
  let i = nl < 0 ? text.length : nl + 1
  const n = text.length
  while (i < n) {
    let e = text.indexOf("\n", i); if (e < 0) e = n
    const end = text.charCodeAt(e - 1) === 13 ? e - 1 : e
    if (end === i) { i = e + 1; continue }
    // past the first field (quoted raw_text, "" escapes)
    let j = i, ok = true
    if (text.charCodeAt(i) === 34) {
      j = i + 1
      for (;;) {
        const q = text.indexOf('"', j)
        if (q < 0 || q >= end) { ok = false; break }
        if (text.charCodeAt(q + 1) === 34) j = q + 2; else { j = q + 1; break }
      }
    } else j = text.indexOf(",", i) < 0 || text.indexOf(",", i) > end ? end : text.indexOf(",", i)
    if (!ok) {   // newline inside quotes: hand the rest of the file to the full parser
      for (const f of parseCsv(text.slice(i))) if (!(f.length === 1 && f[0] === "")) slow(f)
      break
    }
    const line = text.slice(i, end)
    if (line.indexOf('"', j - i) >= 0) { slow(parseCsv(line)[0]!); i = e + 1; continue }
    // commas at or after j delimit columns 1, 2, …: read the ones holding id, lat, lon
    const at: Array<[number, number]> = [[0, j - i]]
    let c = j - i
    for (let k = 1; k <= maxCol && c >= 0 && c < line.length; k++) { const nx = line.indexOf(",", c + 1); at.push([c + 1, nx < 0 ? line.length : nx]); c = nx }
    const field = (k: number) => { const r = at[k]; return r ? line.slice(r[0], r[1]) : undefined }
    keep(line, str(field(C.id)), num(field(C.lat)), num(field(C.lon)))
    i = e + 1
  }

  const memo = new Map<number, Metar>()
  const full = (k: number): Metar => {
    const row = rows[k]!, f = typeof row === "string" ? parseCsv(row)[0]! : row
    const raw = f[C.raw] ?? "", body = raw.split(" RMK ")[0]!
    const variable = VRB.test(body), wd = num(f[C.wd]), ws = num(f[C.ws])
    const visS = f[C.vis] ?? "", plus = visS.endsWith("+")
    const sky: SkyLayer[] = []
    for (const [a, b] of skyCols) { const cover = str(f[a]); if (cover) sky.push({ cover, baseFtAgl: num(f[b]) }) }
    const time = f[C.time] ?? ""
    // vert_vis_ft is in hundreds of feet despite its name: every row checked on 2026-10-29 matched raw VVnnn (KMCW VV001 → 1)
    const vv = num(f[C.vv])
    return {
      stationId: ids[k]!, raw, observationTime: time, observationMs: Date.parse(time), lat: lats[k]!, lon: lons[k]!, elevationM: num(f[C.elev]),
      metarType: str(f[C.type]), flightCategory: str(f[C.fc]),
      temperatureC: num(f[C.t]), dewpointC: num(f[C.td]),
      windDirectionDeg: variable || ws === 0 ? null : wd, windVariable: variable, windSpeedKt: ws, windGustKt: num(f[C.wg]),
      visibilityMi: num(plus ? visS.slice(0, -1) : visS), visibilityPlus: plus,
      altimeterInHg: num(f[C.alt]), seaLevelPressureMb: num(f[C.slp]), wx: str(f[C.wx]), sky, verticalVisibilityFt: vv === null ? null : vv * 100,
    }
  }
  const station = (k: number) => { let m = memo.get(k); if (!m) { m = full(k); memo.set(k, m) } return m }
  const D = Math.PI / 180, xyz = new Float64Array(rows.length * 3)
  for (let k = 0; k < rows.length; k++) { const p = lats[k]! * D, l = lons[k]! * D; xyz[3 * k] = Math.cos(p) * Math.cos(l); xyz[3 * k + 1] = Math.cos(p) * Math.sin(l); xyz[3 * k + 2] = Math.sin(p) }
  return { count: rows.length, station, stationId: k => ids[k]!, xyz, skipped }
}

/** Every station, fully parsed (tests and tools; requests use nearest()). */
export const allStations = (t: Table): Metar[] => Array.from({ length: t.count }, (_, k) => t.station(k))

/** Mean Earth radius (IUGG R1), km: great-circle distances are on this sphere. */
export const EARTH_KM = 6371.0088

/** Great-circle distance (km, haversine) and initial bearing (° true, [0, 360)) from (lat1, lon1) to (lat2, lon2). */
export const greatCircle = (lat1: number, lon1: number, lat2: number, lon2: number) => {
  const D = Math.PI / 180, p1 = lat1 * D, p2 = lat2 * D, dl = (lon2 - lon1) * D
  const h = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2
  const distanceKm = 2 * EARTH_KM * Math.asin(Math.min(1, Math.sqrt(h)))
  const y = Math.sin(dl) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  return { distanceKm, bearing: ((Math.atan2(y, x) / D) % 360 + 360) % 360 }
}

/**
 * The n stations nearest (lat, lon) by great-circle distance. One linear pass of 3 multiply-adds per station over the
 * precomputed unit vectors (the largest dot product is the smallest angle), keeping a sorted top-n; the exact haversine
 * distance and bearing are computed only for the winners. ~5 300 stations; measured in test/metar.test.ts.
 */
export const nearest = (t: Table, lat: number, lon: number, n = 1): Array<{ station: Metar; distanceKm: number; bearing: number }> => {
  const D = Math.PI / 180, p = lat * D, l = lon * D
  const ux = Math.cos(p) * Math.cos(l), uy = Math.cos(p) * Math.sin(l), uz = Math.sin(p)
  const k = Math.max(1, Math.min(n, t.count)), best: number[] = [], dots: number[] = []
  const xyz = t.xyz
  for (let i = 0, m = t.count; i < m; i++) {
    const d = ux * xyz[3 * i]! + uy * xyz[3 * i + 1]! + uz * xyz[3 * i + 2]!
    if (best.length === k && d <= dots[k - 1]!) continue
    let j = best.length === k ? k - 1 : best.length
    while (j > 0 && dots[j - 1]! < d) { dots[j] = dots[j - 1]!; best[j] = best[j - 1]!; j-- }
    dots[j] = d; best[j] = i
    if (best.length > k) { best.length = k; dots.length = k }
  }
  return best.map(i => { const s = t.station(i); return { station: s, ...greatCircle(lat, lon, s.lat, s.lon) } })
}
