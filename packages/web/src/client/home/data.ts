// The page's answers: the server's embedded first frame, the API's (fetched with trace context), or this browser's own
// (src/client/home/compute.ts, once it has taken over). Same shapes either way.
import { batch } from "@preact/signals"
import { tfetch } from "../trace.ts"
import { startRum } from "../rum.ts"
import { coordQuery, dayQuery as dayQ, localDate, nextDate, trackQuery } from "../../lib/time.ts"
import type { Day, Magnetic, Position, Track, Weather } from "../../lib/types.ts"
import { DAYS, K, S, apiErr, center, day, decl, diagRev, env, loc, pos, pose, scrub, tNow, tomorrow, track, wx, wxErr } from "./state.ts"
import { defaultCenter, trackRows } from "./model.ts"
import { drawStrip } from "./strip.ts"
import { tick } from "./tick.ts"
import { dayAt, fetchBlocks, isMissingBlock, takeover, trackFor, blocksFor } from "./compute.ts"
import { aimUpdate } from "./point.ts"

/** GET path?q on the API, with trace context; `quiet`: not the diagnostics' "last answer". */
export const api = async <T>(path: string, q: Record<string, string>, quiet = false): Promise<T> => {
  const url = path + "?" + new URLSearchParams(q).toString(), t0 = performance.now()
  const r = await tfetch(url)
  const b = await r.json() as T & { message?: string; provenance?: Position["provenance"] }
  const ms = performance.now() - t0
  if (!r.ok) throw new Error(b?.message || "HTTP " + r.status)
  if (!quiet) S.last = { url, ms, prov: b.provenance }
  return b
}
export const q = () => coordQuery(loc.peek().lat, loc.peek().lon)

/** The footer shows the API's error. */
export const fail = (e: unknown) => { apiErr.value = e instanceof Error ? e.message : String(e) }

export { defaultCenter, DAYS }

// The diagnostics and the footer: at most once a second, never during a drag (Under the hood redraws them when opened).
let diagAt = 0
export const diag = () => { diagRev.value++ }
export const diagSoon = (dragging: boolean) => { if (dragging) return; const n = Date.now(); if (n - diagAt < 1000) return; diagAt = n; diag() }

/** A new answer on screen: the chart, readouts and words follow the signals. */
export const setPos = (p: Position, dragging = false) => {
  const prev = pos.peek()
  if (!prev) startRum().mark("data-ready")
  batch(() => {
    if (center.peek() == null || (!S.userPanned && !pose.peek() && scrub.peek() == null)) center.value = defaultCenter(p)   // the frame holds still while scrubbed
    pos.value = p
  })
  aimUpdate()
  diagSoon(dragging)
}

/** The live answer: no time parameter, so the front door computes it (never forwarded, never cached; a timed URL would add an
 *  Api hop and a single-use immutable cache entry every 5 s). ?at asks for that instant. */
export const loadPos = () =>
  api<Position>("/v1/position", env.atIso == null ? q() : { ...q(), time: env.atIso })
    .then(p => { S.posAt = Date.now(); S.posErr = null; setPos(p); tick(); takeover(p) })
    .catch((e: unknown) => { S.posErr = e; fail(e) })

export const applyDay = (r: Day) => {
  if (r.provenance) S.dayApi = r
  DAYS.set(r.date, r)
  batch(() => { day.value = r; tomorrow.value = null })
  S.tomorrowFor = null
  drawStrip(); tick()
}
export const loadDay = (): Promise<void> => {
  const today = localDate(tNow(), loc.peek().tz)
  if (K.ready) {
    try { applyDay(dayAt(today)); return Promise.resolve() }
    catch (e) { if (!isMissingBlock(e)) throw e; return fetchBlocks([e.block]).then(loadDay) }
  }
  const t = new Date(tNow()).toISOString()
  batch(() => { day.value = { date: today, events: [], start: t, end: t, loading: true }; tomorrow.value = null })
  S.tomorrowFor = null
  return api<Day>("/v1/day", dayQ(loc.peek().lat, loc.peek().lon, today, loc.peek().tz)).then(applyDay).catch(fail)
}
/** Tomorrow's events matter only once today's have all passed (the Next line); fetched then, once per day. */
export const loadTomorrow = (): Promise<void> => {
  const d = day.peek()
  if (!d) return Promise.resolve()
  S.tomorrowFor = d.date
  if (K.ready) {
    try { tomorrow.value = dayAt(nextDate(d.date)); return Promise.resolve() }
    catch (e) { S.tomorrowFor = null; if (isMissingBlock(e)) void fetchBlocks([e.block]); return Promise.resolve() }
  }
  return api<Day>("/v1/day", { ...q(), date: nextDate(d.date), tz: loc.peek().tz }, true)
    .then(b => { if (day.peek() === d) { tomorrow.value = b; DAYS.set(b.date, b); drawStrip(); tick() } }).catch(() => {})
}

/** Declination comes with the weather answer (observer.magneticDeclination, the same WMM2025 value); /v1/magnetic only if weather fails. */
export const setDecl = (x: number | null) => { decl.value = x; diag() }
export const loadMag = () =>
  api<Magnetic>("/v1/magnetic", q(), true).then(b => { decl.value = b.magnetic.declination; diag() }).catch(() => { decl.value = null })
export const loadWx = () =>
  api<Weather>("/v1/weather", { ...q(), count: "3" }, true).then(b => {
    S.wxAt = Date.now()
    batch(() => { wx.value = b; wxErr.value = null })
    if (decl.peek() !== b.observer.magneticDeclination) setDecl(b.observer.magneticDeclination)
    diag()
  }).catch((e: unknown) => { wxErr.value = e instanceof Error ? e.message : String(e); if (decl.peek() == null) void loadMag() })

/** One /v1/track answer, 20-minute UTC grid (217 samples), over [D − 24 h, D + 48 h] for D = this UTC midnight: now ± 12 h (the
 *  paths) and the local day in any zone from UTC−12 to UTC+14 (the timeline), one immutable, shared cache entry all UTC day.
 *  Fetched at once, in parallel with the rest; again when the UTC date changes. Once the browser computes: its own, wider. */
export const loadTrack = (): Promise<void> => {
  const D = Math.floor(tNow() / 864e5)
  S.trackDay = D
  if (K.ready) {
    try { applyTrack(trackFor(D)); return Promise.resolve() }
    catch (e) { if (!isMissingBlock(e)) throw e; return fetchBlocks(blocksFor((D - 2) * 864e5, (D + 3) * 864e5)).then(loadTrack) }
  }
  return api<Track>("/v1/track", trackQuery(loc.peek().lat, loc.peek().lon, tNow()), true).then(r => { if (S.trackDay === D) applyTrack(r) }).catch(fail)
}
export const applyTrack = (r: Track) => {
  if (r.provenance) S.trackApi = r
  S.trackDay = r.D != null ? r.D : Math.round(Date.parse(r.start) / 864e5) + 1
  track.value = trackRows(r)
  drawStrip()
  performance.mark?.("ephem:track")
}

/** Browser side of src/server/embed: the embedded JSON by id, or null (missing, empty, unparsable). */
export const embed = <T>(id: string): T | null => {
  try { const el = document.getElementById(id); return el?.textContent ? JSON.parse(el.textContent) as T : null } catch { return null }
}
