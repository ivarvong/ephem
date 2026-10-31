// Celestial ↔ terrestrial frames: frame bias, IAU 2006 precession, nutation (Δψ, Δε supplied), sidereal time.
// Formulas: Capitaine et al. 2003 (P03); IERS Conventions 2010 ch. 5; USNO Circular 179.
import { J2000 } from "./time.ts"
import { ASEC, type Mat3, mxm, rotX, rotZ, TAU } from "./linalg.ts"
import type { Instant } from "./time.ts"

/** ICRS → mean J2000 frame bias (IERS 2003: ξ₀, η₀, dα₀), second-order matrix. */
export const BIAS: Mat3 = (() => {
  const xi0 = -0.016617 * ASEC,
    eta0 = -0.0068192 * ASEC,
    da0 = -0.0146 * ASEC
  const yx = -da0,
    zx = xi0,
    xy = da0,
    zy = eta0,
    xz = -xi0,
    yz = -eta0
  return [
    1 - 0.5 * (yx * yx + zx * zx),
    xy,
    xz,
    yx,
    1 - 0.5 * (yx * yx + zy * zy),
    yz,
    zx,
    zy,
    1 - 0.5 * (zy * zy + zx * zx),
  ]
})()

/** Mean obliquity of the ecliptic, IAU 2006 (radians). */
export const meanObliquity = (jdTdb: number): number => {
  const t = (jdTdb - J2000) / 36525
  return (
    (((((-0.0000000434 * t - 0.000000576) * t + 0.0020034) * t - 0.0001831) * t - 46.836769) * t + 84381.406) * ASEC
  )
}

/** Precession J2000 → mean of date, P03 four-angle form R3(χA)·R1(−ωA)·R3(−ψA)·R1(ε0). */
export const precession = (jdTdb: number): Mat3 => {
  const t = (jdTdb - J2000) / 36525
  const eps0 = 84381.406
  const psia = ((((-0.0000000951 * t + 0.000132851) * t - 0.00114045) * t - 1.0790069) * t + 5038.481507) * t
  const omegaa = ((((0.0000003337 * t - 0.000000467) * t - 0.00772503) * t + 0.0512623) * t - 0.025754) * t + eps0
  const chia = ((((-0.000000056 * t + 0.000170663) * t - 0.00121197) * t - 2.3814292) * t + 10.556403) * t
  const sa = Math.sin(eps0 * ASEC),
    ca = Math.cos(eps0 * ASEC)
  const sb = Math.sin(-psia * ASEC),
    cb = Math.cos(-psia * ASEC)
  const sc = Math.sin(-omegaa * ASEC),
    cc = Math.cos(-omegaa * ASEC)
  const sd = Math.sin(chia * ASEC),
    cd = Math.cos(chia * ASEC)
  return [
    cd * cb - sb * sd * cc,
    cd * sb * ca + sd * cc * cb * ca - sa * sd * sc,
    cd * sb * sa + sd * cc * cb * sa + ca * sd * sc,
    -sd * cb - sb * cd * cc,
    -sd * sb * ca + cd * cc * cb * ca - sa * cd * sc,
    -sd * sb * sa + cd * cc * cb * sa + ca * cd * sc,
    sb * sc,
    -sc * cb * ca - sa * cc,
    -sc * cb * sa + cc * ca,
  ]
}

/** Nutation: mean of date → true of date, from Δψ and true/mean obliquity. */
export const nutationMatrix = (epsMean: number, dpsi: number, deps: number): Mat3 => {
  const epsTrue = epsMean + deps
  const cobm = Math.cos(epsMean),
    sobm = Math.sin(epsMean),
    cobt = Math.cos(epsTrue),
    sobt = Math.sin(epsTrue)
  const cpsi = Math.cos(dpsi),
    spsi = Math.sin(dpsi)
  return [
    cpsi,
    -spsi * cobm,
    -spsi * sobm,
    spsi * cobt,
    cpsi * cobm * cobt + sobm * sobt,
    cpsi * sobm * cobt - cobm * sobt,
    spsi * sobt,
    cpsi * cobm * sobt - sobm * cobt,
    cpsi * sobm * sobt + cobm * cobt,
  ]
}

/** Earth rotation angle (fraction of a turn), IAU 2000 B1.8. */
export const earthRotationAngle = (jdUt1: number): number => {
  const th = 0.779057273264 + 0.00273781191135448 * (jdUt1 - J2000)
  return ((((th % 1) + (jdUt1 % 1)) % 1) + 1) % 1
}

/** GMST in radians: ERA + precession-in-RA polynomial (Capitaine 2003 eq. 42). */
export const gmst = (t: Instant): number => {
  const c = (t.jdTDB - J2000) / 36525
  const st = 0.014506 + ((((-0.0000000368 * c - 0.000029956) * c - 0.00000044) * c + 1.3915817) * c + 4612.156534) * c // arcsec
  return (((earthRotationAngle(t.jdUT1) * TAU + st * ASEC) % TAU) + TAU) % TAU
}

/** Complementary terms of the equation of the equinoxes (two leading terms, IERS 2010 Table 5.2e; error < 1 µas). */
const eqeqComplementary = (jdTt: number): number => {
  const t = (jdTt - J2000) / 36525
  const om =
    (450160.398036 + (-482890.5431 + (7.4722 + (0.007702 - 0.00005939 * t) * t) * t) * t) * ASEC + ((-5 * t) % 1) * TAU
  return (2640.96e-6 * Math.sin(om) + 63.52e-6 * Math.sin(2 * om)) * ASEC
}

export interface EarthOrientation {
  readonly M: Mat3 // ICRS → true equator and equinox of date (N·P·B)
  readonly C: Mat3 // ICRS → ITRS (terrestrial), no polar motion: R3(−GAST)·M expressed as active rotZ(−GAST)
  readonly gast: number // radians
  readonly epsMean: number
  readonly epsTrue: number
  readonly dpsi: number
}

export const earthOrientation = (t: Instant, dpsi: number, deps: number): EarthOrientation => {
  const epsMean = meanObliquity(t.jdTDB)
  const M = mxm(nutationMatrix(epsMean, dpsi, deps), mxm(precession(t.jdTDB), BIAS))
  const gast = (((gmst(t) + dpsi * Math.cos(epsMean) + eqeqComplementary(t.jdTT)) % TAU) + TAU) % TAU
  return { M, C: mxm(rotZ(-gast), M), gast, epsMean, epsTrue: epsMean + deps, dpsi }
}

/** ICRS → true ecliptic and equinox of date. */
export const eclipticMatrix = (eo: EarthOrientation): Mat3 => mxm(rotX(-eo.epsTrue), eo.M)
