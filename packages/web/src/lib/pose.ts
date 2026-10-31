// Pointing: where the phone's back camera looks, and which way to turn to a body. Pure; test/pose.test.ts.
import { wrap180, wrap360 } from "./angles.ts"

export interface Pose {
  readonly az: number
  readonly alt: number
}
export interface Orientation {
  readonly alpha: number | null
  readonly beta: number | null
  readonly gamma: number | null
  readonly absolute?: boolean
  readonly webkitCompassHeading?: number | null | undefined
}

/** From a deviceorientation event. The camera is the device's -z axis; with the W3C rotation R = Rz(alpha) Rx(beta) Ry(gamma)
 *  its east/north/up components give the altitude, and its azimuth too when alpha is absolute (Android's
 *  deviceorientationabsolute). iOS gives webkitCompassHeading instead. Both headings are magnetic, so the WMM declination
 *  (east positive) turns them true. Null without a heading. */
export const poseFrom = (e: Orientation, decl: number | null): Pose | null => {
  if (e.beta == null || e.gamma == null) return null
  const a = ((e.alpha || 0) * Math.PI) / 180,
    b = (e.beta * Math.PI) / 180,
    g = (e.gamma * Math.PI) / 180
  const vx = -Math.sin(g) * Math.cos(a) - Math.cos(g) * Math.sin(b) * Math.sin(a),
    vy = -Math.sin(g) * Math.sin(a) + Math.cos(g) * Math.sin(b) * Math.cos(a),
    vz = -Math.cos(b) * Math.cos(g)
  const mag =
    e.webkitCompassHeading != null
      ? e.webkitCompassHeading
      : e.absolute && e.alpha != null
        ? (Math.atan2(vx, vy) * 180) / Math.PI
        : null
  if (mag == null) return null
  return { az: wrap360(mag + (decl || 0)), alt: (Math.asin(Math.max(-1, Math.min(1, vz))) * 180) / Math.PI }
}

/** The compact form, one line per body: "SUN ← 157° ↓22°" (which way to turn and tilt; "on target" within 3°). */
export const aimShort = (name: string, b: Pose, pose: Pose): string => {
  const d = wrap180(b.az - pose.az),
    e = b.alt - pose.alt,
    parts: string[] = []
  if (Math.abs(d) >= 3) parts.push((d < 0 ? "← " : "→ ") + Math.round(Math.abs(d)) + "°")
  if (Math.abs(e) >= 3) parts.push((e < 0 ? "↓" : "↑") + Math.round(Math.abs(e)) + "°")
  return name + " " + (parts.length ? parts.join(" ") : "on target")
}
/** "Moon, 23.4° below the horizon: turn 40° left, tilt 41° down". Within 3° is dead ahead. */
export const aimText = (name: string, b: Pose, pose: Pose): string => {
  const d = wrap180(b.az - pose.az),
    e = b.alt - pose.alt,
    parts: string[] = []
  if (Math.abs(d) >= 3) parts.push("turn " + Math.round(Math.abs(d)) + "° " + (d < 0 ? "left" : "right"))
  if (Math.abs(e) >= 3) parts.push("tilt " + Math.round(Math.abs(e)) + "° " + (e < 0 ? "down" : "up"))
  return (
    name +
    (b.alt < 0 ? ", " + Math.abs(b.alt).toFixed(1) + "° below the horizon" : "") +
    ": " +
    (parts.length ? parts.join(", ") : "dead ahead")
  )
}
