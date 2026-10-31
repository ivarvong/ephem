// The homepage's in-browser core (the web build's core module, packages/web/dist: @ephem/core bundled by Vite) run in real
// headless Chrome (our CDP client) on random cases, against the API's server path (core's positionRequest) run here in Node.
// The gate's packages/web/test/core-parity.test.ts does the same in Node's V8; this is the check on a browser's own Math.
//   node --experimental-strip-types scripts/obs/sky-parity-chrome.ts [cases=400] [seed=20261031]
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DE440, blocksFor, instant, positionRequest, setGeoidSource } from "../../packages/core/src/index.ts"
import { bundledGeoidBand } from "../../packages/core/src/geoid-bundled.ts"
const MANIFEST = JSON.parse(readFileSync(join(import.meta.dirname, "../../packages/web/dist/assets.json"), "utf8"))
const CORE_JS = readFileSync(join(import.meta.dirname, "../../packages/web/dist/client", MANIFEST.core.js), "utf8")
import { launch } from "./cdp/cdp.ts"
import { evaluate } from "./cdp/page.ts"

setGeoidSource(bundledGeoidBand)
const N = Number(process.argv[2] ?? 400),
  SEED = Number(process.argv[3] ?? 20261031)
const whole = readFileSync(join(import.meta.dirname, "../../data/jpl", DE440.file))
const src = (i: number) =>
  whole.buffer.slice(
    whole.byteOffset + (2 + i) * DE440.recBytes,
    whole.byteOffset + (3 + i) * DE440.recBytes,
  ) as ArrayBuffer
let seed = SEED
const r = () => {
  seed |= 0
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const T0 = Date.parse("1900-01-02T00:00:00Z"),
  T1 = Date.parse("2150-12-30T00:00:00Z")
const cases = Array.from({ length: N }, () => {
  const utcMs = Math.round(T0 + r() * (T1 - T0)),
    lat = -90 + 180 * r(),
    lon = -180 + 360 * r()
  const api = positionRequest(src, { utcMs, lat, lon })
  return {
    utcMs,
    api,
    q: {
      utcMs,
      geo: { lat, lon, height: api.observer.heightEllipsoid },
      temperature: api.conventions.refraction.temperatureC,
      pressure: api.conventions.refraction.pressureHpa,
      horizon: api.conventions.horizon.altitude,
    },
  }
})
const need = [...new Set(cases.flatMap((c) => blocksFor(instant(c.utcMs).jdTDB, instant(c.utcMs).jdTDB)))]
const b64 = Object.fromEntries(need.map((i) => [i, Buffer.from(src(i)).toString("base64")]))
const b = await launch({ headless: true })
try {
  const s = await b.newPage()
  await s.send("Runtime.enable")
  await evaluate(
    s,
    `import(URL.createObjectURL(new Blob([${JSON.stringify(CORE_JS)}], { type: "text/javascript" }))).then(m => { window.__ephemCore = m; return 1 })`,
  )
  await evaluate(
    s,
    `window.__B = ${JSON.stringify(b64)}; window.__src = i => { const s = atob(__B[i]); const u = new Uint8Array(s.length); for (let k = 0; k < s.length; k++) u[k] = s.charCodeAt(k); return (__B[i] = u.buffer) }; 1`,
  )
  await evaluate(s, `window.__src2 = i => typeof __B[i] === "string" ? __src(i) : __B[i]; 1`)
  const out = await evaluate<any[]>(
    s,
    `(${JSON.stringify(cases.map((c) => c.q))}).map(q => { const p = __ephemCore.position(__src2, q); return { time: p.time, sun: p.sun, moon: p.moon } })`,
  )
  const ua = await evaluate<string>(s, "navigator.userAgent")
  const ANGLE = /azimuth$|ongitude$|Angle$|elongation$|brightLimbAngleFromVertical$/,
    max = new Map<string, number>(),
    bad: string[] = []
  const diff = (a: any, z: any, path: string) => {
    if (typeof a === "number" && typeof z === "number") {
      let d = Math.abs(a - z)
      if (ANGLE.test(path)) d = Math.abs(((((a - z) % 360) + 540) % 360) - 180)
      max.set(path, Math.max(max.get(path) ?? 0, d))
      return
    }
    if (a === null || z === null || typeof a !== "object") {
      if (a !== z) bad.push(`${path}: ${a} vs ${z}`)
      return
    }
    for (const k of Object.keys(a)) diff(a[k], z[k], path ? `${path}.${k}` : k)
  }
  out.forEach((o, i) => diff(o, { time: cases[i]!.api.time, sun: cases[i]!.api.sun, moon: cases[i]!.api.moon }, ""))
  const worst = Math.max(...[...max].filter(([k]) => !/distanceKm/.test(k)).map(([, v]) => v)),
    km = Math.max(max.get("sun.distanceKm") ?? 0, max.get("moon.distanceKm") ?? 0)
  const nonzero = [...max].filter(([, v]) => v > 0).toSorted((a, z) => z[1] - a[1])
  console.log(
    JSON.stringify(
      {
        chrome: ua.match(/Chrome\/[\d.]+/)?.[0],
        bundle: MANIFEST.core.js,
        cases: N,
        seed: SEED,
        blocks: need.length,
        fields: max.size,
        mismatches: bad.slice(0, 5),
        maxAbsNonDistance: worst,
        maxDistanceKm: km,
        nonzeroFields: Object.fromEntries(nonzero.map(([k, v]) => [k, +v.toPrecision(3)])),
        ok: bad.length === 0 && worst <= 1e-9 && km <= 1e-6,
      },
      null,
      1,
    ),
  )
  if (bad.length || worst > 1e-9 || km > 1e-6) process.exitCode = 1
} finally {
  await b.close()
}
