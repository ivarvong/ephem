// `include=sun,phase` (round-2 #5): context for an alignment track point, an alignment pass or a crossing, so a client
// needs no follow-up /position call. Same definitions as /position.
import type { BlockSource } from "./ephemeris.ts"
import { type Geodetic, apparent, frameAt, topocentric } from "./observe.ts"
import { apparentAltitudeOf, seaDip } from "./horizon.ts"
import { moonPhase } from "./position.ts"
import { instant } from "./time.ts"

export type Include = "sun" | "phase"
export const INCLUDES: ReadonlyArray<Include> = ["sun", "phase"]
/** "sun,phase" → the set; null for anything else (the API's pattern already rejects it). */
export const parseInclude = (s: string | undefined): ReadonlySet<Include> | null => {
  if (s === undefined) return new Set()
  const parts = s.split(",").map(x => x.trim())
  return parts.every(p => (INCLUDES as ReadonlyArray<string>).includes(p)) ? new Set(parts as Include[]) : null
}

/** The Sun seen from `geo` (true and apparent altitude, sea horizon at the eye's height as /position's default) and the
 *  Moon's geocentric phase, at utcMs; only what `inc` asks for. */
export const contextAt = (src: BlockSource, inc: ReadonlySet<Include>, geo: Geodetic, heightMsl: number, utcMs: number,
  o: { dut1?: number | undefined; temperature: number; pressure: number }) => {
  if (inc.size === 0) return {}
  const t = instant(utcMs, o.dut1 ?? 0), out: { sun?: { azimuth: number; altitude: number; apparentAltitude: number | null }; phase?: ReturnType<typeof moonPhase> } = {}
  if (inc.has("sun")) {
    const f = frameAt(src, t, geo), tp = topocentric(f, apparent(src, f, "sun").v)
    out.sun = { azimuth: tp.azimuth, altitude: tp.altitude, apparentAltitude: apparentAltitudeOf(tp.altitude, o.temperature, o.pressure, -seaDip(heightMsl)) }
  }
  if (inc.has("phase")) out.phase = moonPhase(src, t)
  return out
}
export const CONTEXT_CONVENTIONS = "include=sun adds sun {azimuth, altitude (true), apparentAltitude (refracted down to the sea horizon at the eye's height, else null)} seen from that point at that instant; include=phase adds the Moon's geocentric phase {phaseAngle, illuminatedFraction, elongation, brightLimbAngle, name}, as /position."
