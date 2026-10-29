// Time scales. Input is UTC (Unix milliseconds) plus UT1 − UTC; everything else is derived.
//   TAI = UTC + (TAI − UTC)            leap-second table, 1972 onward
//   TT  = TAI + 32.184 s
//   TDB = TT + (TDB − TT)              USNO Circular 179 eq. 2.6 (≤ 2 ms, ~10 µs accurate)
//   UT1 = UTC + dut1                   caller-supplied, |dut1| ≤ 0.9 s
export const J2000 = 2451545.0
const UNIX_EPOCH_JD = 2440587.5

/** UTC dates (ms since epoch) from which TAI − UTC takes the paired value (s). Source: IERS Bulletin C. */
const LEAPS: ReadonlyArray<readonly [number, number]> = [
  ["1972-01-01", 10], ["1972-07-01", 11], ["1973-01-01", 12], ["1974-01-01", 13], ["1975-01-01", 14], ["1976-01-01", 15],
  ["1977-01-01", 16], ["1978-01-01", 17], ["1979-01-01", 18], ["1980-01-01", 19], ["1981-07-01", 20], ["1982-07-01", 21],
  ["1983-07-01", 22], ["1985-07-01", 23], ["1988-01-01", 24], ["1990-01-01", 25], ["1991-01-01", 26], ["1992-07-01", 27],
  ["1993-07-01", 28], ["1994-07-01", 29], ["1996-01-01", 30], ["1997-07-01", 31], ["1999-01-01", 32], ["2006-01-01", 33],
  ["2009-01-01", 34], ["2012-07-01", 35], ["2015-07-01", 36], ["2017-01-01", 37],
].map(([d, s]) => [Date.parse(`${d}T00:00:00Z`), s as number] as const)

export const SUPPORTED = { fromMs: Date.parse("1972-01-01T00:00:00Z"), toMs: Date.parse("2150-01-01T00:00:00Z") } as const

/** TAI − UTC in seconds at a UTC instant. Before 1972 it is undefined in this model (callers reject it). */
export const taiMinusUtc = (utcMs: number): number => {
  for (let i = LEAPS.length - 1; i >= 0; i--) if (utcMs >= LEAPS[i]![0]) return LEAPS[i]![1]   // newest first: nearly every query is after 2017
  return 10
}

export const tdbMinusTt = (jdTt: number): number => {
  const t = (jdTt - J2000) / 36525
  return 0.001657 * Math.sin(628.3076 * t + 6.2401)
    + 0.000022 * Math.sin(575.3385 * t + 4.2970)
    + 0.000014 * Math.sin(1256.6152 * t + 6.1969)
    + 0.000005 * Math.sin(606.9777 * t + 4.0212)
    + 0.000005 * Math.sin(52.9691 * t + 0.4444)
    + 0.000002 * Math.sin(21.3299 * t + 5.5431)
    + 0.000010 * t * Math.sin(628.3076 * t + 4.2490)
}

export interface Instant {
  readonly utcMs: number
  readonly jdUtc: number
  readonly jdTT: number
  readonly jdTDB: number
  readonly jdUT1: number
  readonly dut1: number      // UT1 − UTC, s
  readonly deltaT: number    // TT − UT1, s
}

export const instant = (utcMs: number, dut1 = 0): Instant => {
  const jdUtc = utcMs / 86400000 + UNIX_EPOCH_JD
  const ttMinusUtc = taiMinusUtc(utcMs) + 32.184
  const jdTT = jdUtc + ttMinusUtc / 86400
  return {
    utcMs, jdUtc, jdTT,
    jdTDB: jdTT + tdbMinusTt(jdTT) / 86400,
    jdUT1: jdUtc + dut1 / 86400,
    dut1, deltaT: ttMinusUtc - dut1,
  }
}

/** Shift an instant by seconds of UTC (no leap second can fall inside the shift in practice for ≤ 1 day; leap table is re-read). */
export const addSeconds = (t: Instant, s: number): Instant => instant(t.utcMs + s * 1000, t.dut1)

export const isoMs = (utcMs: number): string => new Date(Math.round(utcMs)).toISOString()
