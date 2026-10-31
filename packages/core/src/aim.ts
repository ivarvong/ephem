// Aim points on a disc: the centre, the upper or lower limb along the local vertical, or the centroid of the
// Moon's illuminated area. All in the true (unrefracted) sky, topocentric; callers refract the aim point's altitude.
//
// Lit-area centroid. Seen from the observer the Moon is a disc of angular radius r (topocentric, asin(R☾/d)). With
// parallel sunlight at phase angle i (angle Sun–Moon–observer), the lit part is bounded by the bright limb (a semicircle)
// and the terminator, a semi-ellipse with semi-minor axis r·|cos i|. With x along the bright-limb direction and y across it,
// the lit region is −cos i·√(r² − y²) ≤ x ≤ √(r² − y²), so
//   area = (1 + cos i)·πr²/2,   first moment = ½·∫(1 − cos² i)(r² − y²) dy = (2/3)·r³·sin² i,
//   centroid x̄ = (4r / 3π)·sin² i / (1 + cos i) = (4r / 3π)·(1 − cos i),   ȳ = 0 by symmetry.
// Checks: full (i = 0) → 0; quarter (i = 90°) → 4r/3π = 0.424 r, a half-disc's centroid; thin crescent (i → 180°) → 8r/3π.
// Its direction on the sky is the bright limb's: the Sun's direction from the Moon projected on the sky plane at the Moon.
// The projection uses the vector Sun − Moon, whose sky-plane component equals the Sun's own (Moon − observer is along the
// line of sight), so it is exact for a finite Sun distance. Orthographic: the perspective of a sphere 1737 km in radius at
// ≥ 356 000 km changes the centroid by < 0.5 % of r (validated by numeric integration over the sphere, DESIGN.md §10).
import { type Vec3, DEG, cross, dot, norm, scale, sub, wrap360 } from "./linalg.ts"

export type Aim = "center" | "upper" | "lower" | "litCentroid"
export const AIMS: ReadonlyArray<Aim> = ["center", "upper", "lower", "litCentroid"]
export const LIT_CENTROID_K = 4 / (3 * Math.PI)

export const AIM_DEFINITIONS: Readonly<Record<Aim, string>> = {
  center: "the centre of the disc",
  upper:
    "the upper limb: the disc centre moved by the topocentric angular radius towards the zenith along the local vertical, in the true sky; then refracted",
  lower:
    "the lower limb: the disc centre moved by the topocentric angular radius away from the zenith along the local vertical, in the true sky; then refracted",
  litCentroid:
    "the centroid of the Moon's illuminated area: (4r/3π)·(1 − cos i) from the centre towards the bright limb (the Sun's direction from the Moon projected on the sky), i the topocentric phase angle, r the topocentric angular radius; orthographic disc, parallel sunlight; in the true sky, then refracted",
}

const unit = (v: Vec3): Vec3 => scale(v, 1 / norm(v))
/** Up on the sky at direction m̂ (towards the zenith, perpendicular to m̂), and right (towards increasing azimuth). */
const skyBasis = (m: Vec3, up: Vec3): { vert: Vec3; right: Vec3 } | null => {
  const v = sub(up, scale(m, dot(up, m))),
    n = norm(v)
  if (n < 1e-12) return null // at the zenith or nadir: no vertical
  const vert = scale(v, 1 / n)
  return { vert, right: cross(m, vert) } // facing m̂ with vert up, right is towards increasing azimuth
}

/** Bright limb and lit-area centroid of the Moon seen from the eye. `moon`, `sun`: apparent vectors from the eye (any
 *  common frame and length unit); `up`: the eye's zenith in that frame; `radiusDeg`: the Moon's topocentric angular radius. */
export const litGeometry = (moon: Vec3, sun: Vec3, up: Vec3, radiusDeg: number) => {
  const m = unit(moon),
    sm = sub(sun, moon)
  const cosI = dot(unit(sm), scale(m, -1)),
    phaseAngle = Math.acos(Math.max(-1, Math.min(1, cosI))) / DEG
  const d = sub(sm, scale(m, dot(sm, m))),
    b = skyBasis(m, up)
  const angleFromVertical = b && norm(d) > 0 ? wrap360(Math.atan2(dot(d, b.right), dot(d, b.vert)) / DEG) : null
  return {
    phaseAngle, // topocentric, degrees
    illuminatedFraction: (1 + cosI) / 2, // topocentric
    brightLimbAngleFromVertical: angleFromVertical, // degrees clockwise from the local vertical as the observer sees it
    centroidOffset: LIT_CENTROID_K * (1 - cosI) * radiusDeg, // degrees from the disc centre towards the bright limb
    direction: norm(d) > 0 ? unit(d) : null, // unit vector on the sky plane towards the bright limb
  }
}

/** Unit vector to the aim point, its offset from the centre (degrees) and the offset's angle clockwise from the local
 *  vertical. `sun` is required for litCentroid. Upper / lower: the limb along the local vertical (offset = radius). */
export const aimVector = (
  aim: Aim,
  moon: Vec3,
  up: Vec3,
  radiusDeg: number,
  sun?: Vec3,
): { dir: Vec3; offset: number; angleFromVertical: number | null } => {
  const m = unit(moon)
  if (aim === "center") return { dir: m, offset: 0, angleFromVertical: null }
  let d: Vec3 | null, rho: number, ang: number | null
  if (aim === "litCentroid") {
    const g = litGeometry(moon, sun!, up, radiusDeg)
    d = g.direction
    rho = g.centroidOffset
    ang = g.brightLimbAngleFromVertical
  } else {
    const b = skyBasis(m, up)
    d = b ? (aim === "upper" ? b.vert : scale(b.vert, -1)) : null
    rho = radiusDeg
    ang = aim === "upper" ? 0 : 180
  }
  if (!d || rho === 0) return { dir: m, offset: 0, angleFromVertical: ang }
  const c = Math.cos(rho * DEG),
    s = Math.sin(rho * DEG)
  return { dir: [m[0] * c + d[0] * s, m[1] * c + d[1] * s, m[2] * c + d[2] * s], offset: rho, angleFromVertical: ang }
}
