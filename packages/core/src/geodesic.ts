// WGS-84 geodesics by Vincenty (1975): direct and inverse, with the standard convergence guard.
// Accuracy ≈ 0.5 mm except for nearly antipodal pairs, which this API never needs (≤ 200 km).
import { DEG, wrap360 } from "./linalg.ts"

const A = 6378137.0, F = 1 / 298.257223563, B = A * (1 - F)

export interface Direct { readonly lat: number; readonly lon: number; readonly finalAzimuth: number }
export interface Inverse { readonly distanceM: number; readonly azimuth: number; readonly finalAzimuth: number }

/** Point at `distanceM` from (lat, lon) along initial `azimuth` (degrees, from north through east). */
export const direct = (lat: number, lon: number, azimuth: number, distanceM: number): Direct => directLine(lat, lon, azimuth)(distanceM)

/** The geodesic from (lat, lon) along `azimuth` as a function of distance: the distance-independent terms are computed once. */
export const directLine = (lat: number, lon: number, azimuth: number): ((distanceM: number) => Direct) => {
  const phi1 = lat * DEG, alpha1 = azimuth * DEG
  const sinA1 = Math.sin(alpha1), cosA1 = Math.cos(alpha1)
  const tanU1 = (1 - F) * Math.tan(phi1), cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1), sinU1 = tanU1 * cosU1
  const sigma1 = Math.atan2(tanU1, cosA1)
  const sinAlpha = cosU1 * sinA1, cos2Alpha = 1 - sinAlpha * sinAlpha
  const u2 = cos2Alpha * (A * A - B * B) / (B * B)
  const k1 = (Math.sqrt(1 + u2) - 1) / (Math.sqrt(1 + u2) + 1)
  const Acoef = (1 + k1 * k1 / 4) / (1 - k1), Bcoef = k1 * (1 - 3 * k1 * k1 / 8)
  const C = F / 16 * cos2Alpha * (4 + F * (4 - 3 * cos2Alpha))
  return (s: number): Direct => {
    let sigma = s / (B * Acoef), sigmaP = 0, cos2SigmaM = 0, sinSigma = 0, cosSigma = 0
    for (let i = 0; i < 100; i++) {
      cos2SigmaM = Math.cos(2 * sigma1 + sigma); sinSigma = Math.sin(sigma); cosSigma = Math.cos(sigma)
      const dSigma = Bcoef * sinSigma * (cos2SigmaM + Bcoef / 4 * (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)
        - Bcoef / 6 * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)))
      sigmaP = sigma; sigma = s / (B * Acoef) + dSigma
      if (Math.abs(sigma - sigmaP) < 1e-13) break
    }
    const tmp = sinU1 * sinSigma - cosU1 * cosSigma * cosA1
    const phi2 = Math.atan2(sinU1 * cosSigma + cosU1 * sinSigma * cosA1, (1 - F) * Math.sqrt(sinAlpha * sinAlpha + tmp * tmp))
    const lambda = Math.atan2(sinSigma * sinA1, cosU1 * cosSigma - sinU1 * sinSigma * cosA1)
    const L = lambda - (1 - C) * F * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)))
    const alpha2 = Math.atan2(sinAlpha, -tmp)
    return { lat: phi2 / DEG, lon: ((lon + L / DEG + 540) % 360) - 180, finalAzimuth: wrap360(alpha2 / DEG) }
  }
}

/** Distance and azimuths between two points. Throws for nearly antipodal inputs (no convergence). */
export const inverse = (lat1: number, lon1: number, lat2: number, lon2: number): Inverse => {
  const phi1 = lat1 * DEG, phi2 = lat2 * DEG, L = (lon2 - lon1) * DEG
  const tanU1 = (1 - F) * Math.tan(phi1), cosU1 = 1 / Math.sqrt(1 + tanU1 * tanU1), sinU1 = tanU1 * cosU1
  const tanU2 = (1 - F) * Math.tan(phi2), cosU2 = 1 / Math.sqrt(1 + tanU2 * tanU2), sinU2 = tanU2 * cosU2
  let lambda = L, lambdaP = 0, iter = 0
  let sinSigma = 0, cosSigma = 0, sigma = 0, cos2Alpha = 0, cos2SigmaM = 0, sinLambda = 0, cosLambda = 0
  do {
    sinLambda = Math.sin(lambda); cosLambda = Math.cos(lambda)
    const t1 = cosU2 * sinLambda, t2 = cosU1 * sinU2 - sinU1 * cosU2 * cosLambda
    sinSigma = Math.sqrt(t1 * t1 + t2 * t2)
    if (sinSigma === 0) return { distanceM: 0, azimuth: 0, finalAzimuth: 0 }   // coincident points
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda
    sigma = Math.atan2(sinSigma, cosSigma)
    const sinAlpha = cosU1 * cosU2 * sinLambda / sinSigma
    cos2Alpha = 1 - sinAlpha * sinAlpha
    cos2SigmaM = cos2Alpha !== 0 ? cosSigma - 2 * sinU1 * sinU2 / cos2Alpha : 0   // equatorial line
    const C = F / 16 * cos2Alpha * (4 + F * (4 - 3 * cos2Alpha))
    lambdaP = lambda
    lambda = L + (1 - C) * F * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)))
    if (++iter > 200) throw new RangeError("Vincenty inverse did not converge (nearly antipodal points)")
  } while (Math.abs(lambda - lambdaP) > 1e-13)
  const u2 = cos2Alpha * (A * A - B * B) / (B * B)
  const k1 = (Math.sqrt(1 + u2) - 1) / (Math.sqrt(1 + u2) + 1)
  const Acoef = (1 + k1 * k1 / 4) / (1 - k1), Bcoef = k1 * (1 - 3 * k1 * k1 / 8)
  const dSigma = Bcoef * sinSigma * (cos2SigmaM + Bcoef / 4 * (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)
    - Bcoef / 6 * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)))
  const s = B * Acoef * (sigma - dSigma)
  const alpha1 = Math.atan2(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda)
  const alpha2 = Math.atan2(cosU1 * sinLambda, -sinU1 * cosU2 + cosU1 * sinU2 * cosLambda)
  return { distanceM: s, azimuth: wrap360(alpha1 / DEG), finalAzimuth: wrap360(alpha2 / DEG) }
}
