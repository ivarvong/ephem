// Words and number formats the page shows. Pure; test/words.test.ts.
import { dirWord, wrap360 } from "./angles.ts"
import type { Body, BodyKey, Moon, Station, Wind } from "./types.ts"

export const countdown = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return "in " + s + " s"
  let m = Math.round(s / 60)
  const h = Math.floor(m / 60)
  m = m % 60
  return "in " + (h ? h + " h" + (m ? " " + m + " min" : "") : m + " min")
}
export const ago = (sec: number): string => {
  const s = Math.max(0, Math.round(sec))
  if (s < 90) return s + " s ago"
  if (s < 5400) return Math.round(s / 60) + " min ago"
  return (s / 3600).toFixed(1) + " h ago"
}
/** apparentAltitude is null below the observer's horizon (API 2026-10-29); drawing falls back to the true altitude there. */
export const altOf = (b: Pick<Body, "altitude" | "apparentAltitude">): number => (b.apparentAltitude == null ? b.altitude : b.apparentAltitude)

const bodyPhrase = (name: string, b: Body): string | null => {
  const a = altOf(b), dir = dirWord(b.azimuth)
  if (a < 0) return null
  if (a < 8) return name + " is low in the " + dir
  if (a < 40) return name + " is in the " + dir
  return name + " is high in the " + dir
}
/** One sentence for what's up (the chart's aria-description). */
export const lede = (sun: Body, moon: Moon): string => {
  const sa = altOf(sun), east = wrap360(sun.azimuth) < 180
  const s = bodyPhrase("The Sun", sun) || (sa >= -6 ? (east ? "It's dawn" : "It's dusk") : sa >= -18 ? "It's twilight" : "It's night")
  const ph = moon.phase, mname = ph && ph.illuminatedFraction >= 0.03 ? "the " + ph.name.toLowerCase() + " Moon" : "the Moon"
  const m = bodyPhrase(mname, moon)
  return s + (m ? ", and " + m : " and the Moon is down") + "."
}

// METAR present-weather codes to words (WMO 306 / FAA 7900.5 subset); unknown tokens fall through verbatim.
const WXD: Readonly<Record<string, string>> = { MI: "shallow", BC: "patchy", PR: "partial", DR: "drifting", BL: "blowing", TS: "thunderstorm with", FZ: "freezing" }
const WXP: Readonly<Record<string, string>> = { DZ: "drizzle", RA: "rain", SN: "snow", SG: "snow grains", IC: "ice crystals", PL: "ice pellets", GR: "hail", GS: "small hail", UP: "precipitation",
  BR: "mist", FG: "fog", FU: "smoke", VA: "volcanic ash", DU: "dust", SA: "sand", HZ: "haze", PY: "spray", PO: "dust whirls", SQ: "squalls", FC: "funnel cloud", SS: "sandstorm", DS: "duststorm" }
export const wxWord = (tok: string): string => {
  const m = /^([-+]?)(VC)?((?:MI|BC|PR|DR|BL|SH|TS|FZ)*)((?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)*)$/.exec(tok)
  if (!m || !(m[3] || m[4])) return tok
  const ds: string[] = (m[3] ?? "").match(/../g) ?? [], sh = ds.includes("SH"), p = ((m[4] ?? "").match(/../g) ?? []).map(x => WXP[x])
  const d = ds.filter(x => x !== "SH").map(x => WXD[x])
  const w = d.concat(p.length ? [p.join(" and ") + (sh ? " showers" : "")] : sh ? ["showers"] : []).join(" ").replace(/ with$/, "")
  return (m[1] === "-" ? "light " : m[1] === "+" ? "heavy " : "") + w + (m[2] ? " nearby" : "")
}
const COVER: Readonly<Record<string, string>> = { SKC: "Clear", CLR: "Clear", NCD: "Clear", NSC: "Clear", CAVOK: "Clear", FEW: "Mostly clear", SCT: "Partly cloudy", BKN: "Mostly cloudy", OVC: "Overcast", OVX: "Sky obscured" }
const RANK = ["SKC", "CLR", "NCD", "NSC", "CAVOK", "FEW", "SCT", "BKN", "OVC", "OVX"]
type Cond = Pick<Station, "raw" | "sky"> & { readonly wx?: string | null | undefined; readonly verticalVisibilityFt?: number | null | undefined }
/** Present weather in words, else the thickest cloud layer. */
export const condition = (st: Cond): string => {
  if (st.wx) { const w = st.wx.split(/ +/).map(wxWord).join(", "); return w.charAt(0).toUpperCase() + w.slice(1) }
  if (st.verticalVisibilityFt != null) return "Sky obscured"
  let top: string | null = null
  for (const l of st.sky ?? []) if (top == null || RANK.indexOf(l.cover) > RANK.indexOf(top)) top = l.cover
  if (top) return COVER[top] ?? top
  return / (CLR|SKC|CAVOK|NSC) /.test(" " + st.raw + " ") ? "Clear" : "Sky not reported"
}
/** METAR wind direction is reported to the nearest 10 degrees, so whole degrees here (the one exception to the page's
 *  two-decimal rule for bearings). decl: magnetic declination, east positive. */
export const windText = (w: Wind, decl: number | null | undefined): string => {
  if (w.speedKt == null) return "Wind not reported"
  if (w.calm) return "Wind calm"
  const dir = w.variable || w.directionDegTrue == null ? "variable"
    : Math.round(wrap360(w.directionDegTrue)) + "° T" + (decl == null ? "" : " · " + Math.round(wrap360(w.directionDegTrue - decl)) % 360 + "° M")
  return "Wind " + dir + " at " + w.speedKt + " kt" + (w.gustKt ? ", gusting " + w.gustKt + " kt" : "")
}

/** "Night", "Civil twilight", … from the Sun's altitude. */
export const skyPhase = (a: number): string =>
  a >= 0 ? "Daylight" : a >= -6 ? "Civil twilight" : a >= -12 ? "Nautical twilight" : a >= -18 ? "Astronomical twilight" : "Night"

/** The countdown: always HH:MM:SS. */
export const hhmmss = (ms: number): string => {
  let s = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60
  s = s % 60
  return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s
}
/** "IN 3 H 20 MIN", "2 H AGO", "IN 45 S": a scrubbed instant's offset from now. */
export const offText = (ms: number): string => {
  const s = Math.round(Math.abs(ms) / 1000), m = Math.round(s / 60), h = Math.floor(m / 60)
  const d = s < 90 ? s + " S" : (h ? h + " H" + (m % 60 ? " " : "") : "") + (m % 60 ? (m % 60) + " MIN" : "")
  return ms < 0 ? d + " ago" : "in " + d
}

export const NAMES: Readonly<Record<BodyKey, Readonly<Record<string, string>>>> = {
  sun: { rise: "Sunrise", set: "Sunset", transit: "Solar noon", civilDawn: "Civil dawn", civilDusk: "Civil dusk", nauticalDawn: "Nautical dawn", nauticalDusk: "Nautical dusk",
    astronomicalDawn: "Astronomical dawn", astronomicalDusk: "Astronomical dusk", goldenHourStart: "Golden hour", goldenHourEnd: "Golden hour ends", blueHourStart: "Blue hour", blueHourEnd: "Blue hour ends" },
  moon: { rise: "Moonrise", set: "Moonset", transit: "Moon culmination" },
}
export const evName = (e: { readonly body: BodyKey; readonly kind: string }): string => NAMES[e.body]?.[e.kind] ?? e.kind

/** Angles at two decimals with the degree sign. */
export const d2 = (x: number): string => x.toFixed(2) + "°"
/** A true azimuth, [0, 360) at two decimals ("359.996" is 0.00). */
export const azT = (x: number): string => { const v = wrap360(x); return (v >= 359.995 ? 0 : v).toFixed(2) + "° T" }
/** The magnetic azimuth for declination decl (east positive), or "" without one. */
export const azM = (x: number, decl: number | null): string => {
  if (decl == null) return ""
  const v = wrap360(x - decl)
  return (v >= 359.995 ? 0 : v).toFixed(2) + "° M"
}
