// Angles and compass words. Degrees throughout; azimuth from true north through east.

export const wrap360 = (x: number): number => ((x % 360) + 360) % 360
export const wrap180 = (x: number): number => ((x % 360) + 540) % 360 - 180

const DIRS = ["north", "north-northeast", "northeast", "east-northeast", "east", "east-southeast", "southeast", "south-southeast",
  "south", "south-southwest", "southwest", "west-southwest", "west", "west-northwest", "northwest", "north-northwest"] as const
const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"] as const

/** "north-northeast" for an azimuth. */
export const dirWord = (az: number): string => DIRS[Math.round(wrap360(az) / 22.5) % 16]!
/** "NNE" for an azimuth. */
export const compass16 = (az: number): string => COMPASS[Math.round(wrap360(az) / 22.5) % 16]!

export const D2R = Math.PI / 180
/** Kilometres per astronomical unit (IAU 2012). */
export const AU_KM = 149597870.7

/** Parallactic angle q (deg): position angle of the zenith, from altitude/azimuth, declination and latitude. */
export const parallactic = (alt: number, az: number, dec: number, lat: number): number => {
  const h = alt * D2R, A = az * D2R, p = lat * D2R, d = dec * D2R
  const H = Math.atan2(-Math.cos(h) * Math.sin(A), Math.cos(p) * Math.sin(h) - Math.sin(p) * Math.cos(h) * Math.cos(A))
  return Math.atan2(Math.sin(H), Math.tan(p) * Math.cos(d) - Math.sin(d) * Math.cos(H)) / D2R
}
