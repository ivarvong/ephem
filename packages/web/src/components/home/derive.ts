// What the homepage shows, derived from its state (src/client/home/state.ts). Computed signals: a component binds them to text
// nodes and attributes, so a new answer every second patches text, not trees. Pure reads; safe on the server (where the state
// never leaves its initial values and every derived value is the empty first frame).
import { computed } from "@preact/signals"
import { AU_KM, compass16, wrap360 } from "../../lib/angles.ts"
import { trackEvents } from "../../lib/chart.ts"
import { ago, altOf, azM, azT, condition, d2, evName, hhmmss, lede, skyPhase, windText } from "../../lib/words.ts"
import { fmt, hm, hms, localDate } from "../../lib/time.ts"
import type { BodyKey, Day, DayEvent, Position } from "../../lib/types.ts"
import { K, S, baseTime, compute, day, decl, env, loc, now, pos, scrub, tickRev, tomorrow, track, wx } from "../../client/home/state.ts"

const MAIN = (e: DayEvent) => e.kind === "rise" || e.kind === "set" || e.kind === "transit" || /Dawn|Dusk|HourStart/.test(e.kind)

// ---- header ----
export const clockText = computed(() => (baseTime.value ? hms(baseTime.value, loc.value.tz) : "--:--:--"))
export const liveState = computed(() => {
  void tickRev.value
  const sim = scrub.value != null, age = S.posAt ? (Date.now() - S.posAt) / 1000 : null
  const st = S.posErr ? "alert" : sim ? "caution" : age == null ? "" : age < 15 ? "ok" : "caution"
  const text = st === "alert" ? "No signal" : sim ? "Not live: the sky at another time" : env.at != null && st ? "Fixed time" : st === "ok" ? "Live" : st === "caution" ? "Delayed" : "Acquiring"
  return { cls: "dot " + st, text }
})
export const liveClass = computed(() => liveState.value.cls)
export const liveText = computed(() => liveState.value.text)
/** The device's clock, when it is off by more than 3 s (and more than the measurement's ±): the page shows Cloudflare's. */
const skewOn = computed(() => { const c = env.clk; return !!baseTime.value && Math.abs(c.off) > 3000 && Math.abs(c.off) > c.pm && env.at == null })
export const skewHidden = computed(() => !skewOn.value)
export const skewText = computed(() => (skewOn.value ? "CLOCK " + (env.clk.off > 0 ? "−" : "+") + Math.round(Math.abs(env.clk.off) / 1000) + " S" : "\u00a0"))   // hidden when not shown; never an empty text node (hydration)
export const skewTitle = computed(() => (skewOn.value ? "This device's clock is " + (Math.abs(env.clk.off) / 1000).toFixed(1) + " s " + (env.clk.off > 0 ? "behind" : "ahead of") + " Cloudflare's; the page shows Cloudflare's time" : undefined))

// ---- the chart's accessible text ----
const ariaAlt = (b: Position["sun"]) => (b.apparentAltitude == null ? "below the horizon (true altitude " + b.altitude.toFixed(2) + " degrees)" : b.apparentAltitude.toFixed(2) + " degrees apparent altitude")
export const skyLabel = computed(() => { const p = pos.value; return p ? "Sun " + ariaAlt(p.sun) + ", azimuth " + p.sun.azimuth.toFixed(2) + " degrees true; Moon " + ariaAlt(p.moon) + ", azimuth " + p.moon.azimuth.toFixed(2) + " degrees true" : "Sky chart" })
export const skyDescription = computed(() => { const p = pos.value; return p ? lede(p.sun, p.moon) : undefined })

// ---- countdown ----
const upcoming = (t: number) => [...(day.value?.events ?? []), ...(tomorrow.value?.events ?? [])].filter(MAIN).filter(e => Date.parse(e.time) > t)
export interface NextLine { readonly name: string; readonly time: string; readonly tomorrow: boolean }
let lastNext: NextLine | string | null = null
export const countdown = computed(() => {
  const t = now.value, up = upcoming(t), d = day.value, tz = loc.value.tz
  if (up.length) {
    const e = up[0]!, te = Date.parse(e.time)
    lastNext = { name: evName(e).toUpperCase(), time: hm(te, tz), tomorrow: localDate(te, tz) !== localDate(t, tz) }
    return { t: "T−" + hhmmss(te - t), next: lastNext }
  }
  if (d && !d.loading && S.tomorrowFor === d.date && tomorrow.value) lastNext = "No rise, set or twilight in the next two days"
  return { t: "T−--:--:--", next: lastNext }
})
export const tminus = computed(() => countdown.value.t)
const nextLine = computed(() => countdown.value.next)
/** the NEXT line's shape: an event (name · time [TOMORROW]), a sentence, or nothing yet */
export const nextKind = computed(() => { const n = nextLine.value; return n == null ? "none" : typeof n === "string" ? "text" : "event" })
export const nextName = computed(() => { const n = nextLine.value; return n == null ? "" : typeof n === "string" ? n : n.name + " · " })
export const nextTime = computed(() => { const n = nextLine.value; return n && typeof n !== "string" ? n.time : "" })
export const nextTomorrow = computed(() => { const n = nextLine.value; return n && typeof n !== "string" && n.tomorrow ? " TOMORROW" : "" })
export const phaseText = computed(() => { const p = pos.value; return p ? skyPhase(altOf(p.sun)) : null })

// ---- readouts ----
// The tracks' culminations, recomputed only when the track, today's events or the minute change (not per drag frame).
let TI: { key: string; ev: Partial<Record<BodyKey, ReturnType<typeof trackEvents>>> } = { key: "", ev: {} }
const HALF = { sun: 12 * 3600e3, moon: 12 * 3600e3 + 25 * 60e3 } as const
const trackInfo = (nowMs: number) => {
  const rows = track.value, d = day.value, key = rows.length + ":" + rows[0]?.t + ":" + d?.date + ":" + d?.events.length + ":" + Math.floor(nowMs / 60e3)
  if (TI.key === key) return TI.ev
  const dayEv = [...(d?.events ?? []), ...(tomorrow.value?.events ?? [])], ev: typeof TI.ev = {}
  for (const body of ["sun", "moon"] as const) {
    const s = rows.filter(x => Math.abs(x.t - nowMs) <= HALF[body]).map(x => ({ t: x.t, alt: x[body].altitude, az: x[body].azimuth }))
    ev[body] = trackEvents(s, -0.833).map(e => {   // the exact /v1/day time when it has this event
      const k = e.kind === "antitransit" ? null : e.kind, m = k && dayEv.find(x => x.body === body && x.kind === k && Math.abs(Date.parse(x.time) - e.t) < 40 * 60e3)
      return m ? { ...e, t: Date.parse(m.time) } : e
    })
  }
  TI = { key, ev }
  return ev
}
const dayTimes = (key: BodyKey, d: Day | null, tz: string) => {
  const ev = d ? d.events.filter(e => e.body === key) : [], f = (k: string) => { const e = ev.find(x => x.kind === k); return e ? hm(Date.parse(e.time), tz) : "—" }
  const tr = ev.find(x => x.kind === "transit"), ti = track.value.length ? trackInfo(now.value) : {}
  const info = ti[key] && tr ? ti[key]!.find(e => e.kind === "transit" && Math.abs(e.t - Date.parse(tr.time)) < 40 * 60e3) : null
  return { rise: f("rise"), set: f("set"), transit: f("transit"), transitAlt: info ? d2(info.alt) : "" }
}
export interface Readout { readonly alt: string; readonly az: string; readonly compass: string | null; readonly rise: string; readonly set: string; readonly lit: string | null }
const readout = (key: BodyKey): Readout | null => {
  const p = pos.value
  if (!p) return null
  const b = p[key], a = altOf(b), dt = dayTimes(key, day.value, loc.value.tz), dc = decl.value
  return { alt: (a < 0 ? "−" : "") + Math.abs(a).toFixed(2), az: wrap360(b.azimuth).toFixed(2), compass: dc == null ? null : Math.round(wrap360(b.azimuth - dc)) % 360 + "°",
    rise: dt.rise, set: dt.set, lit: key === "moon" ? (p.moon.phase.illuminatedFraction * 100).toFixed(0) + "%" : null }
}
const readouts = { sun: computed(() => readout("sun")), moon: computed(() => readout("moon")) }
export const hasReadouts = computed(() => !!readouts.sun.value && !!readouts.moon.value)
/** One readout field as a string signal (equal strings notify nobody: the DOM is touched only when the text changes). */
export const field = (key: BodyKey, f: keyof Readout, suffix = "") => computed(() => (readouts[key].value?.[f] ?? "") + suffix)
export const hasCompass = computed(() => readouts.sun.value?.compass != null)

// Short caps labels (nothing wraps at 375). Apparent altitude is the API's: refracted, and null when the centre would lie below
// the observer's horizon (it can be null while the upper limb, which defines rise and set, is already up).
const detailRows = computed((): ReadonlyArray<readonly [string, string]> | null => {
  const p = pos.value
  if (!p) return null
  const s = p.sun, mo = p.moon, tz = loc.value.tz, ds = dayTimes("sun", day.value, tz), dm = dayTimes("moon", day.value, tz), dc = decl.value
  const app = (b: Position["sun"]) => (b.apparentAltitude == null ? "below horizon" : d2(b.apparentAltitude))
  const az = (x: number) => azT(x).replace(" T", "") + (azM(x, dc) ? " · " + azM(x, dc).replace(" M", "") : "")
  return [
    ["Sun alt true · seen", d2(s.altitude) + " · " + app(s)],
    ["Sun az true · mag", az(s.azimuth)],
    ["Solar noon", ds.transit + (ds.transitAlt ? " · " + ds.transitAlt : "")],
    ["Sun dist", (s.distanceKm / AU_KM).toFixed(5) + " au"],
    ["Moon alt true · seen", d2(mo.altitude) + " · " + app(mo)],
    ["Moon az true · mag", az(mo.azimuth)],
    ["Moon culmination", dm.transit + (dm.transitAlt ? " · " + dm.transitAlt : "")],
    ["Moon dist", Math.round(mo.distanceKm).toLocaleString("en-US") + " km"],
    ["Moon phase", mo.phase.name + " · " + (mo.phase.illuminatedFraction * 100).toFixed(1) + "%"],
  ]
})

export const hasDetails = computed(() => detailRows.value != null)
export const DETAIL_LABELS = ["Sun alt true · seen", "Sun az true · mag", "Solar noon", "Sun dist", "Moon alt true · seen", "Moon az true · mag", "Moon culmination", "Moon dist", "Moon phase"] as const
export const detailValues = DETAIL_LABELS.map((_, i) => computed(() => detailRows.value?.[i]?.[1] ?? ""))

// ---- all events today (drawn when the day arrives; past/future as of then) ----
export const dayTitle = computed(() => {
  const d = day.value
  return d && !d.loading ? "All events · " + fmt(loc.value.tz, { weekday: "long", day: "numeric", month: "long" }).format(new Date(Date.parse(d.start) + 12 * 3600e3)) : "All events today"
})
export const eventRows = computed(() => {
  const d = day.value
  if (!d || d.loading) return null
  const t = now.peek(), tz = loc.value.tz
  return d.events.map(e => { const te = Date.parse(e.time); return { past: te < t, body: e.body, name: evName(e), time: hm(te, tz) } })
})

// ---- weather ----
export const wxView = computed(() => {
  const w = wx.value
  if (!w) return null
  if (!w.stations.length) return { none: true as const }
  const s = w.stations[0]!, dc = decl.value ?? w.observer?.magneticDeclination ?? null, tz = loc.value.tz, wd = s.wind
  const clouds = !s.sky.length ? (s.verticalVisibilityFt != null ? "Vertical visibility " + s.verticalVisibilityFt + " ft" : / (CLR|SKC|CAVOK|NSC) /.test(" " + s.raw + " ") ? "None" : "Not reported")
    : s.sky.map(l => l.cover + (l.baseFtAgl != null ? " " + l.baseFtAgl.toLocaleString("en-US") + " ft" : "")).join(", ")
  return {
    none: false as const, s, condition: condition(s), wind: wd, windText: windText(wd, dc) + ". Clouds: " + clouds,
    station: s.stationId + " · " + s.distanceKm.toFixed(1) + " KM " + compass16(s.bearing.true),
    raws: w.stations.map(x => ({ comment: "# " + x.stationId + ", " + x.distanceKm.toFixed(2) + " km, observed " + x.observationTime.slice(11, 16) + "Z (" + hm(Date.parse(x.observationTime), tz) + " local)", raw: x.raw })),
  }
})
/** Seconds since the answer arrived, on top of the observation's age (METARs are hourly; amber once one is a quarter-hour overdue). */
const wxAgeS = computed(() => {
  void tickRev.value
  const w = wx.value
  return !w || !w.stations.length ? null : w.stations[0]!.observationAgeSeconds + (Date.now() - S.wxAt) / 1000
})
export const wxAgeText = computed(() => (wxAgeS.value == null ? "" : "METAR " + ago(wxAgeS.value).toUpperCase()))
export const wxAgeClass = computed(() => (wxAgeS.value != null && wxAgeS.value > 3600 ? "age warn" : "age"))

export const computeState = compute
export { K }
