// Clocks, local dates and the DE440 block arithmetic the browser needs before it has @ephem/core. Pure; test/time.test.ts.

/** Server − device clock offset from Navigation Timing: the server wrote `serverNow` into the head, which arrived between
 *  requestStart and responseStart, so the offset is the midpoint of that window, ± half its width. Without timing, `now`
 *  bounds the arrival (an upper bound). */
export interface ClockOffset { readonly off: number; readonly pm: number; readonly nt: boolean }
export const clockOffset = (serverNow: number, nav: { readonly requestStart: number; readonly responseStart: number } | null | undefined, timeOrigin: number, now: number): ClockOffset => {
  const nt = !!(nav && nav.requestStart > 0 && nav.responseStart >= nav.requestStart)
  const lo = nt ? timeOrigin + nav!.requestStart : now, hi = nt ? timeOrigin + nav!.responseStart : now
  return { off: serverNow - (lo + hi) / 2, pm: (hi - lo) / 2, nt }
}

/** "YYYY-MM-DD" in zone tz. */
export const localDate = (ms: number, tz: string): string => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(ms))
/** The calendar day after "YYYY-MM-DD". */
export const nextDate = (d: string): string => { const [y, m, dd] = d.split("-").map(Number); return new Date(Date.UTC(y!, m! - 1, dd! + 1)).toISOString().slice(0, 10) }
export const isoSeconds = (ms: number): string => new Date(ms).toISOString().slice(0, 19) + "Z"

const fmts = new Map<string, Intl.DateTimeFormat>()
/** A cached 24-hour formatter in zone tz. */
export const fmt = (tz: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat => {
  const k = JSON.stringify(opts) + tz
  let f = fmts.get(k)
  if (!f) { f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour12: false, ...opts }); fmts.set(k, f) }
  return f
}
export const hm = (ms: number, tz: string): string => fmt(tz, { hour: "2-digit", minute: "2-digit" }).format(new Date(ms))
export const hms = (ms: number, tz: string): string => fmt(tz, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(ms))

/** The first-load queries, built exactly as the page builds them, so an embedded answer is the one the browser would have
 *  fetched: lat/lon at 5 decimals, the track window from this UTC day ([D − 24 h, D + 48 h] on the 20-minute grid: now ± 12 h
 *  and the local day in any zone, one shared immutable entry all UTC day), today in tz. */
export const coordQuery = (lat: number, lon: number) => ({ lat: lat.toFixed(5), lon: lon.toFixed(5) })
export const trackQuery = (lat: number, lon: number, now: number) => {
  const D = Math.floor(now / 864e5), t0 = (D - 1) * 864e5
  return { ...coordQuery(lat, lon), start: isoSeconds(t0), end: isoSeconds(t0 + 72 * 3600e3) }
}
export const dayQuery = (lat: number, lon: number, date: string, tz: string) => ({ ...coordQuery(lat, lon), date, tz })

/** The DE440 block of a UTC instant, without the ephemeris code (so the blocks are fetched alongside it): TDB is UTC + 32.184 s
 *  + the leap seconds (37 s since 2017; 0.0008 d at most since 1972) and light time adds at most 0.006 d; ±0.02 d covers both. */
export const DE440_BLOCKS = 12556
export const blockOf = (ms: number): number => Math.floor((ms / 864e5 + 2440587.5 + 69.184 / 86400 - 2287184.5) / 32)
export const blocksFor = (a: number, b: number): number[] => {
  const out: number[] = []
  for (let i = blockOf(a - 0.02 * 864e5); i <= blockOf(b + 0.02 * 864e5); i++) if (i >= 0 && i < DE440_BLOCKS) out.push(i)
  return out
}
