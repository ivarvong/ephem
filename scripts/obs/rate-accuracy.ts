// Rate accuracy sweep (offline, fixture blocks): N random (instant within ±3 h of an oracle fixture, place) samples.
//   node --experimental-strip-types scripts/obs/rate-accuracy.ts [N=20000] [seed=1]
// Prints, °/min: test = |rate − ±2 s difference| (properties.test.ts' statistic; its own floor ≈ 2.5e-6 from 40 µs JD
// rounding), split by |alt| < 80, nadir band (−89, −80) and the last degree; truth = |rate − Richardson(30 s, 60 s)| for
// |alt| < 80 (az × cos alt). Run it against an older checkout (ROOT=<worktree>) for a before/after.
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
const HERE = resolve(import.meta.dirname, "../.."), ROOT = process.env.ROOT ?? HERE
const { position } = await import(`${ROOT}/packages/core/src/position.ts`)
const blocks = new Map<number, ArrayBuffer>()
const src = (i: number) => {
  let b = blocks.get(i)
  if (!b) {
    let fn = `${HERE}/packages/core/test/fixtures/blocks/${i}.bin`; if (!existsSync(fn)) fn = `${HERE}/data/jpl/blocks/${i}.bin`
    const buf = readFileSync(fn); b = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer; blocks.set(i, b)
  }
  return b
}
const fixtureMs = [...new Set(JSON.parse(readFileSync(`${HERE}/packages/core/test/fixtures/oracle.json`, "utf8")).position.map((c: { query: { time: string } }) => Date.parse(c.query.time)))] as number[]
let seed = Number(process.argv[3] ?? 1) >>> 0
const rnd = () => { seed = (seed + 0x6D2B79F5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }   // mulberry32
const N = Number(process.argv[2] ?? 20000)
const dAz = (b: number, a: number) => ((b - a) % 360 + 540) % 360 - 180
const st = { testAbsAlt80: 0, testNadirBand: 0, testLastDegree: 0, over1e5AbsAlt89: 0, over1e5LastDegree: 0, truthAlt: 0, truthAzCos: 0 }
for (let i = 0; i < N; i++) {
  const ms = Math.round(fixtureMs[Math.floor(rnd() * fixtureMs.length)]! + (rnd() * 2 - 1) * 3 * 3600_000)
  const geo = { lat: -89.9 + rnd() * 179.8, lon: -180 + rnd() * 360, height: -100 + rnd() * 5100 }
  const P = (t: number) => position(src, { utcMs: t, geo })
  const r = P(ms), a = P(ms - 2000), b = P(ms + 2000), m1 = P(ms - 30000), p1 = P(ms + 30000), m2 = P(ms - 60000), p2 = P(ms + 60000)
  for (const k of ["sun", "moon"] as const) {
    const alt = r[k].altitude, e = Math.abs(r[k].altitudeRate - (b[k].altitude - a[k].altitude) * 15)
    if (Math.abs(alt) < 80) {
      st.testAbsAlt80 = Math.max(st.testAbsAlt80, e)
      const tAlt = (4 * (p1[k].altitude - m1[k].altitude) - (p2[k].altitude - m2[k].altitude) / 2) / 3
      const tAz = (4 * dAz(p1[k].azimuth, m1[k].azimuth) - dAz(p2[k].azimuth, m2[k].azimuth) / 2) / 3
      st.truthAlt = Math.max(st.truthAlt, Math.abs(r[k].altitudeRate - tAlt))
      st.truthAzCos = Math.max(st.truthAzCos, Math.abs(r[k].azimuthRate - tAz) * Math.cos(alt * Math.PI / 180))
    } else if (alt < -80 && alt > -89) st.testNadirBand = Math.max(st.testNadirBand, e)
    else if (alt <= -89) { st.testLastDegree = Math.max(st.testLastDegree, e); if (e >= 1e-5) st.over1e5LastDegree++ }
    if (alt < 80 && alt > -89 && e >= 1e-5) st.over1e5AbsAlt89++
  }
}
console.log(JSON.stringify({ N, seed: process.argv[3] ?? 1, root: ROOT, ...Object.fromEntries(Object.entries(st).map(([k, v]) => [k, Number(v.toPrecision(3))])) }))
