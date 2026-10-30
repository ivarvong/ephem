// Golden answers: crossVersionCache keeps cached answers across deploys, so changing a deterministic answer without bumping
// CACHE_VERSION (src/cache-version.ts) would serve the old answer from cache indefinitely. These requests' bodies (minus
// provenance / diagnostics) are hashed and committed with the CACHE_VERSION they were recorded at.
//   answers changed on purpose → bump CACHE_VERSION, then re-record:  npm run golden:record
import { describe, expect, it } from "vitest"
import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { makeHandler } from "../src/app.ts"
import { direct, makeBlocks } from "../src/blocks.ts"
import { deterministic } from "../src/responses.ts"
import { CACHE_VERSION } from "../src/cache-version.ts"

const FILE = resolve(__dirname, "golden/answers.json")
const FIX = resolve(__dirname, "../../core/test/fixtures/blocks")   // committed DE440 blocks (5441–5444 cover Sep–Dec 2026)
const handler = makeHandler(makeBlocks(direct(async first => { const b = readFileSync(`${FIX}/${first}.bin`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer })))

/** Representative deterministic requests: every route the Api caches immutably. */
export const GOLDEN: Record<string, string> = {
  "day.nyc": "/v1/day?date=2026-10-28&tz=America/New_York&lat=40.7127&lon=-74.0059&height=10",
  "day.tromso": "/v1/day?date=2026-11-15&tz=Europe/Oslo&lat=69.6492&lon=18.9553",
  "position.nyc": "/v1/position?lat=40.7127&lon=-74.0059&height=-22.6&time=2026-10-28T11:51:00Z",
  "position.sydney.refraction": "/v1/position?lat=-33.8568&lon=151.2153&time=2026-10-29T08:30:00Z&temperature=25&pressure=1005",
  "alignment.moon.liberty": "/v1/alignment?body=moon&targetLat=40.68925&targetLon=-74.0445&targetHeight=63.4&observerHeight=-30.9&start=2026-10-28T23:45:00Z&end=2026-10-29T02:00:00Z&stepSeconds=1800&maxDistanceKm=20&observerLat=40.6892&observerLon=-74.076",
  "crossing.sun.civil": "/v1/crossing?body=sun&altitude=-6&lat=40.7&lon=-74&date=2026-10-28&tz=America/New_York",
  "crossing.moon.apparent": "/v1/crossing?body=moon&altitude=0&altitudeType=apparent&lat=51.5&lon=-0.12&start=2026-10-27T00:00:00Z&end=2026-10-30T00:00:00Z",
  "track.nyc": "/v1/track?lat=40.7127&lon=-74.0059&height=-22.6&start=2026-10-27T12:00:00Z&end=2026-10-29T12:00:00Z",
  "track.tromso.step": "/v1/track?lat=69.6492&lon=18.9553&start=2026-11-15T00:00:00Z&end=2026-11-16T00:00:00Z&stepSeconds=600&temperature=-15&pressure=1020&horizon=geometric",
  "sightline.pier6": "/v1/sightline?observerLat=40.6935&observerLon=-74.0017&observerHeight=5&heightRef=msl&targetLat=40.68925&targetLon=-74.0445&targetHeight=70&targetHeightRef=msl&samples=21&obstacles=40.6894:-74.0166:25",
  "magnetic.nyc": "/v1/magnetic?lat=40.7&lon=-74&time=2026-10-29T12:00:00Z",
}

const strip = (x: unknown): unknown => Array.isArray(x) ? x.map(strip) : x && typeof x === "object"
  ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== "provenance" && k !== "diagnostics").map(([k, v]) => [k, strip(v)])) : x
const hashOf = async (path: string) => {
  const r = await handler(new Request("http://x" + path))
  const text = await r.text()
  if (r.status !== 200) throw new Error(`${path}: ${r.status} ${text.slice(0, 200)}`)
  return createHash("sha256").update(JSON.stringify(strip(JSON.parse(text)))).digest("hex").slice(0, 32)
}

describe("golden answers", () => {
  it("every golden request is a deterministic (immutably cached) route", () => {
    for (const p of Object.values(GOLDEN)) expect(deterministic(new URL("http://x" + p)), p).toBe(true)
  })
  it("answers unchanged, or CACHE_VERSION bumped and re-recorded", async () => {
    const now: Record<string, string> = {}
    for (const [name, path] of Object.entries(GOLDEN)) now[name] = await hashOf(path)
    if (process.env.GOLDEN_RECORD) {
      writeFileSync(FILE, JSON.stringify({ cacheVersion: CACHE_VERSION, recorded: new Date().toISOString(), requests: GOLDEN, answers: now }, null, 2) + "\n")
      return
    }
    const saved = JSON.parse(readFileSync(FILE, "utf8")) as { cacheVersion: number; answers: Record<string, string> }
    const changed = Object.keys({ ...now, ...saved.answers }).filter(k => now[k] !== saved.answers[k])
    if (saved.cacheVersion === CACHE_VERSION && changed.length)
      throw new Error(`answers changed: bump CACHE_VERSION and re-record (npm run golden:record). Changed: ${changed.join(", ")}`)
    if (saved.cacheVersion !== CACHE_VERSION)
      throw new Error(`CACHE_VERSION is ${CACHE_VERSION} but answers were recorded at ${saved.cacheVersion}: re-record (npm run golden:record)`)
  }, 60_000)
})
