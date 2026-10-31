// World Magnetic Model 2025 (NOAA NCEI / BGS, epoch 2025.0, valid 2025.0–2030.0): degree-12 spherical-harmonic main field
// with linear secular variation, evaluated as in the WMM2025 Technical Report (Chulliat et al., NOAA NCEI, 2024), §1.2:
// geodetic → geocentric spherical, Schmidt semi-normalised associated Legendre functions, field in spherical components,
// rotated back to the geodetic (north, east, down) frame. Declination D = atan2(Y, X), positive east: magnetic = true − D.
// Coefficients: WMM.COF from WMM2025COF.zip (ncei.noaa.gov/sites/default/files/2024-12/WMM2025COF.zip,
// zip sha256 2e76569370d081f2cd7919490218bd094ca9afde347b198eff5621e0af460d03, WMM.COF sha256
// dfa8597825af4e0b87ff4198a5b4fb661b3c49f4cd090cd0164e0259b075582f), rows copied verbatim: n m g h ġ ḣ (nT, nT/yr).
// Verified against WMM2025_TestValues.txt from the same package (test/wmm.test.ts).
import { DEG } from "./linalg.ts"

export const WMM_EPOCH = 2025.0
export const WMM_VALID = { from: 2025.0, to: 2030.0 } as const
const COF = `  1  0  -29351.8       0.0       12.0        0.0
  1  1   -1410.8    4545.4        9.7      -21.5
  2  0   -2556.6       0.0      -11.6        0.0
  2  1    2951.1   -3133.6       -5.2      -27.7
  2  2    1649.3    -815.1       -8.0      -12.1
  3  0    1361.0       0.0       -1.3        0.0
  3  1   -2404.1     -56.6       -4.2        4.0
  3  2    1243.8     237.5        0.4       -0.3
  3  3     453.6    -549.5      -15.6       -4.1
  4  0     895.0       0.0       -1.6        0.0
  4  1     799.5     278.6       -2.4       -1.1
  4  2      55.7    -133.9       -6.0        4.1
  4  3    -281.1     212.0        5.6        1.6
  4  4      12.1    -375.6       -7.0       -4.4
  5  0    -233.2       0.0        0.6        0.0
  5  1     368.9      45.4        1.4       -0.5
  5  2     187.2     220.2        0.0        2.2
  5  3    -138.7    -122.9        0.6        0.4
  5  4    -142.0      43.0        2.2        1.7
  5  5      20.9     106.1        0.9        1.9
  6  0      64.4       0.0       -0.2        0.0
  6  1      63.8     -18.4       -0.4        0.3
  6  2      76.9      16.8        0.9       -1.6
  6  3    -115.7      48.8        1.2       -0.4
  6  4     -40.9     -59.8       -0.9        0.9
  6  5      14.9      10.9        0.3        0.7
  6  6     -60.7      72.7        0.9        0.9
  7  0      79.5       0.0       -0.0        0.0
  7  1     -77.0     -48.9       -0.1        0.6
  7  2      -8.8     -14.4       -0.1        0.5
  7  3      59.3      -1.0        0.5       -0.8
  7  4      15.8      23.4       -0.1        0.0
  7  5       2.5      -7.4       -0.8       -1.0
  7  6     -11.1     -25.1       -0.8        0.6
  7  7      14.2      -2.3        0.8       -0.2
  8  0      23.2       0.0       -0.1        0.0
  8  1      10.8       7.1        0.2       -0.2
  8  2     -17.5     -12.6        0.0        0.5
  8  3       2.0      11.4        0.5       -0.4
  8  4     -21.7      -9.7       -0.1        0.4
  8  5      16.9      12.7        0.3       -0.5
  8  6      15.0       0.7        0.2       -0.6
  8  7     -16.8      -5.2       -0.0        0.3
  8  8       0.9       3.9        0.2        0.2
  9  0       4.6       0.0       -0.0        0.0
  9  1       7.8     -24.8       -0.1       -0.3
  9  2       3.0      12.2        0.1        0.3
  9  3      -0.2       8.3        0.3       -0.3
  9  4      -2.5      -3.3       -0.3        0.3
  9  5     -13.1      -5.2        0.0        0.2
  9  6       2.4       7.2        0.3       -0.1
  9  7       8.6      -0.6       -0.1       -0.2
  9  8      -8.7       0.8        0.1        0.4
  9  9     -12.9      10.0       -0.1        0.1
 10  0      -1.3       0.0        0.1        0.0
 10  1      -6.4       3.3        0.0        0.0
 10  2       0.2       0.0        0.1       -0.0
 10  3       2.0       2.4        0.1       -0.2
 10  4      -1.0       5.3       -0.0        0.1
 10  5      -0.6      -9.1       -0.3       -0.1
 10  6      -0.9       0.4        0.0        0.1
 10  7       1.5      -4.2       -0.1        0.0
 10  8       0.9      -3.8       -0.1       -0.1
 10  9      -2.7       0.9       -0.0        0.2
 10 10      -3.9      -9.1       -0.0       -0.0
 11  0       2.9       0.0        0.0        0.0
 11  1      -1.5       0.0       -0.0       -0.0
 11  2      -2.5       2.9        0.0        0.1
 11  3       2.4      -0.6        0.0       -0.0
 11  4      -0.6       0.2        0.0        0.1
 11  5      -0.1       0.5       -0.1       -0.0
 11  6      -0.6      -0.3        0.0       -0.0
 11  7      -0.1      -1.2       -0.0        0.1
 11  8       1.1      -1.7       -0.1       -0.0
 11  9      -1.0      -2.9       -0.1        0.0
 11 10      -0.2      -1.8       -0.1        0.0
 11 11       2.6      -2.3       -0.1        0.0
 12  0      -2.0       0.0        0.0        0.0
 12  1      -0.2      -1.3        0.0       -0.0
 12  2       0.3       0.7       -0.0        0.0
 12  3       1.2       1.0       -0.0       -0.1
 12  4      -1.3      -1.4       -0.0        0.1
 12  5       0.6      -0.0       -0.0       -0.0
 12  6       0.6       0.6        0.1       -0.0
 12  7       0.5      -0.1       -0.0       -0.0
 12  8      -0.1       0.8        0.0        0.0
 12  9      -0.4       0.1        0.0       -0.0
 12 10      -0.2      -1.0       -0.1       -0.0
 12 11      -1.3       0.1       -0.0        0.0
 12 12      -0.7       0.2       -0.1       -0.1`

const N = 12
const A_WGS = 6378.137,
  F_WGS = 1 / 298.257223563,
  E2 = F_WGS * (2 - F_WGS),
  RE = 6371.2 // km; RE = WMM reference radius
const idx = (n: number, m: number) => (n * (n + 1)) / 2 + m
const G = new Float64Array(idx(N, N) + 1),
  H = new Float64Array(G.length),
  GD = new Float64Array(G.length),
  HD = new Float64Array(G.length)
for (const line of COF.split("\n")) {
  const [n, m, g, h, gd, hd] = line.trim().split(/\s+/).map(Number) as [number, number, number, number, number, number]
  const i = idx(n, m)
  G[i] = g
  H[i] = h
  GD[i] = gd
  HD[i] = hd
}

/** Decimal year as the WMM software computes it: year + (day of year − 1 + fraction of day) / days in year (UTC). */
export const decimalYear = (utcMs: number): number => {
  const d = new Date(utcMs),
    y = d.getUTCFullYear(),
    y0 = Date.UTC(y, 0, 1),
    y1 = Date.UTC(y + 1, 0, 1)
  return y + (utcMs - y0) / (y1 - y0)
}

export interface MagneticField {
  /** degrees, east positive: magnetic bearing = true bearing − declination */
  readonly declination: number
  /** degrees, down positive */
  readonly inclination: number
  /** nT: north, east, down (geodetic frame), horizontal intensity, total intensity */
  readonly x: number
  readonly y: number
  readonly z: number
  readonly h: number
  readonly f: number
}

/**
 * WMM2025 field at geodetic latitude/longitude (degrees), height above the WGS-84 ellipsoid (km), and decimal year.
 * Outside 2025.0–2030.0 the secular variation is extrapolated; callers report the validity window.
 * At the geographic poles declination is undefined; latitude is clamped to ±(90 − 1e-6)°, as the WMM software does.
 */
export const wmm = (latDeg: number, lonDeg: number, heightKm: number, year: number): MagneticField => {
  const lat = Math.max(-90 + 1e-6, Math.min(90 - 1e-6, latDeg)) * DEG,
    lon = lonDeg * DEG
  // geodetic → geocentric spherical (report eq. 7–8)
  const sinLat = Math.sin(lat),
    cosLat = Math.cos(lat)
  const rc = A_WGS / Math.sqrt(1 - E2 * sinLat * sinLat)
  const p = (rc + heightKm) * cosLat,
    zc = (rc * (1 - E2) + heightKm) * sinLat
  const r = Math.hypot(p, zc),
    latc = Math.asin(zc / r)
  const x = Math.sin(latc),
    s = Math.cos(latc) // cos θ, sin θ (θ = geocentric colatitude)
  const dt = year - WMM_EPOCH
  // Schmidt semi-normalised P_n^m(cos θ) and dP/dθ by the standard recurrences
  const P = new Float64Array(G.length),
    dP = new Float64Array(G.length)
  P[0] = 1
  dP[0] = 0
  for (let n = 1; n <= N; n++) {
    for (let m = 0; m <= n; m++) {
      const i = idx(n, m)
      if (n === m) {
        const k = n === 1 ? 1 : Math.sqrt((2 * n - 1) / (2 * n)),
          j = idx(n - 1, n - 1)
        P[i] = k * s * P[j]!
        dP[i] = k * (s * dP[j]! + x * P[j]!)
      } else {
        const j = idx(n - 1, m),
          a = Math.sqrt(n * n - m * m)
        const b = n >= 2 && m <= n - 2 ? Math.sqrt((n - 1) * (n - 1) - m * m) : 0
        const p2 = b ? P[idx(n - 2, m)]! : 0,
          dp2 = b ? dP[idx(n - 2, m)]! : 0
        P[i] = ((2 * n - 1) * x * P[j]! - b * p2) / a
        dP[i] = ((2 * n - 1) * (x * dP[j]! - s * P[j]!) - b * dp2) / a
      }
    }
  }
  // field in geocentric spherical components (report eq. 10–12): X′ north, Y′ east, Z′ down
  let X = 0,
    Y = 0,
    Z = 0
  const ar = RE / r
  let arn = ar * ar // (a/r)^(n+2), starting at n = 0
  for (let n = 1; n <= N; n++) {
    arn *= ar
    let sx = 0,
      sy = 0,
      sz = 0
    for (let m = 0; m <= n; m++) {
      const i = idx(n, m),
        g = G[i]! + dt * GD[i]!,
        h = H[i]! + dt * HD[i]!
      const cm = Math.cos(m * lon),
        sm = Math.sin(m * lon)
      const t = g * cm + h * sm
      sx += t * dP[i]! // −∂/∂φ′ = +∂/∂θ
      sy += m * (g * sm - h * cm) * P[i]!
      sz += t * P[i]!
    }
    X += arn * sx
    Y += arn * sy
    Z -= (n + 1) * arn * sz
  }
  Y /= s
  // rotate to the geodetic frame (report eq. 17)
  const psi = latc - lat,
    cp = Math.cos(psi),
    sp = Math.sin(psi)
  const xg = X * cp - Z * sp,
    zg = X * sp + Z * cp
  const hh = Math.hypot(xg, Y)
  return {
    declination: Math.atan2(Y, xg) / DEG,
    inclination: Math.atan2(zg, hh) / DEG,
    x: xg,
    y: Y,
    z: zg,
    h: hh,
    f: Math.hypot(hh, zg),
  }
}

/** The model's coefficient rows as embedded (n m g h ġ ḣ), for the provenance test against WMM.COF. */
/** WMM2025 technical report §4.4: where the horizontal field H is under 2000 nT (the blackout zones around the dip poles)
 *  the declination is unreliable and a compass does not work; 2000–6000 nT is the caution zone. */
export const COMPASS_ZONES = { blackoutBelowNt: 2000, cautionBelowNt: 6000 } as const
export const compassZone = (hNt: number): "ok" | "caution" | "blackout" =>
  hNt < COMPASS_ZONES.blackoutBelowNt ? "blackout" : hNt < COMPASS_ZONES.cautionBelowNt ? "caution" : "ok"
export const WMM_COF_ROWS = COF
