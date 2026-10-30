// Concurrent A/B load: both arms (ephem versions pinned with Cloudflare-Workers-Version-Overrides) get the identical open-loop
// schedule, fired at the same instants (arm order alternates per tick):
//   cold   POST /v1/alignment/search, 12-month Brooklyn Bridge Park scan, fresh target height (14 never-seen windows), 124/min
//   pos    GET /v1/position (live, no time: computed in the front door), every 200 ms
//   warm   GET of a pre-warmed deterministic key (day / track / alignment, 24 keys cycled), every 400 ms
// node --experimental-strip-types scripts/obs/split-ab/load.ts <S-id> <E-id> <tag> [runs=6] [runSec=240] [gapSec=60] [warmupSec=60]
// Writes $AB_DIR (default ./ab-runs)/<tag>.jsonl (every request) and <tag>.windows.json (run windows). Brooklyn Bridge Park
// region: scripts/obs/split-ab/brooklyn-bridge-park.geojson. Used for the 2026-10-30 A/B (guide "Compute split").
import fs from "node:fs"
const [S, E, tag] = process.argv.slice(2, 5) as [string, string, string]
const RUNS = Number(process.argv[5] ?? 6), RUN = Number(process.argv[6] ?? 240) * 1000, GAP = Number(process.argv[7] ?? 60) * 1000, WARM = Number(process.argv[8] ?? 60) * 1000
const B = "https://ephem.ivar.workers.dev", dir = new URL(`file://${(process.env.AB_DIR ?? "ab-runs").replace(/^(?!\/)/, process.cwd() + "/")}/`)
fs.mkdirSync(dir, { recursive: true })
const park = JSON.parse(fs.readFileSync(new URL("brooklyn-bridge-park.geojson", import.meta.url), "utf8"))
const arms = { S, E } as const
const out = fs.createWriteStream(new URL(`${tag}.jsonl`, dir))
let phase = "prewarm"
const hdr = (arm: "S" | "E") => ({ "cloudflare-workers-version-overrides": `ephem="${arms[arm]}"` })
const warmKeys: string[] = []
for (let d = 1; d <= 8; d++) {
  const day = `2026-11-${String(d).padStart(2, "0")}`
  warmKeys.push(`/v1/day?lat=40.7&lon=-74&date=${day}&tz=America/New_York`)
  warmKeys.push(`/v1/track?lat=40.7&lon=-74&start=${day}T00:00:00Z&end=2026-11-${String(d + 1).padStart(2, "0")}T00:00:00Z`)
  warmKeys.push(`/v1/alignment?body=moon&targetLat=40.68925&targetLon=-74.0445&targetHeight=63.4&start=${day}T02:00:00Z&end=${day}T03:00:00Z`)
}
const req = async (arm: "S" | "E", kind: string, path: string, init: RequestInit = {}, timeout = 5000) => {
  const at = Date.now(), t0 = performance.now()
  try {
    const r = await fetch(B + path, { ...init, headers: { ...hdr(arm), ...(init.headers ?? {}) }, signal: AbortSignal.timeout(timeout) })
    const body = await r.text(); const ms = performance.now() - t0
    let cache = r.headers.get("x-ephem-cache")
    if (kind === "cold") { try { const j = JSON.parse(body); cache = JSON.stringify(j.provenance?.diagnostics?.cache ?? j.search?.windows?.map((w: any) => w.cache)) } catch { /* */ } }
    out.write(JSON.stringify({ phase, arm, kind, at, ms: Math.round(ms), st: r.status, ray: r.headers.get("cf-ray"), v: r.headers.get("x-ephem-version")?.slice(0, 8), cv: r.headers.get("x-ephem-compute-version")?.slice(0, 8), cache }) + "\n")
  } catch (e) { out.write(JSON.stringify({ phase, arm, kind, at, ms: Math.round(performance.now() - t0), st: 0, err: String(e).slice(0, 120) }) + "\n") }
}
const scanBody = () => JSON.stringify({ body: "moon", target: { lat: 40.68925, lon: -74.0445, height: 71 + Math.random(), heightRef: "msl" }, region: park, observerHeight: 5, heightRef: "msl", start: "2026-10-30T00:00:00Z", end: "2027-10-30T00:00:00Z" })
// open loop: each stream fires on its own fixed period, never waiting for responses
const streams: Array<{ period: number; fire: (arm: "S" | "E", i: number) => void }> = [
  { period: 60000 / 124, fire: arm => void req(arm, "cold", "/v1/alignment/search", { method: "POST", headers: { "content-type": "application/json" }, body: scanBody() }, 20000) },
  { period: 200, fire: arm => void req(arm, "pos", "/v1/position?lat=40.7&lon=-74") },
  { period: 400, fire: (arm, i) => void req(arm, "warm", warmKeys[i % warmKeys.length]!) },
]
const drive = (ms: number) => new Promise<void>(done => {
  const t0 = performance.now(), timers: NodeJS.Timeout[] = []
  for (const s of streams) {
    let i = 0
    const tick = () => {
      const now = performance.now(); if (now - t0 >= ms) return
      const order: Array<"S" | "E"> = i % 2 ? ["E", "S"] : ["S", "E"]; for (const a of order) s.fire(a, i)
      i++; timers.push(setTimeout(tick, Math.max(0, t0 + i * s.period - performance.now())))
    }
    tick()
  }
  setTimeout(() => { timers.forEach(clearTimeout); done() }, ms)
})
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const windows: Array<{ run: string; from: string; to: string }> = []
const saveWin = () => fs.writeFileSync(new URL(`${tag}.windows.json`, dir), JSON.stringify({ S, E, windows }, null, 1))
// prewarm: every warm key twice per arm (the arms are different Workers' caches in this A/B)
for (const k of warmKeys) for (const a of ["S", "E"] as const) { await req(a, "prewarm", k); await req(a, "prewarm", k) }
phase = "warmup"; { const f = new Date().toISOString(); await drive(WARM); windows.push({ run: "warmup", from: f, to: new Date().toISOString() }); saveWin() }
for (let r = 1; r <= RUNS; r++) {
  phase = "gap"; await sleep(GAP)
  phase = `r${r}`; const f = new Date().toISOString(); await drive(RUN); windows.push({ run: phase, from: f, to: new Date().toISOString() }); saveWin()
  console.log(JSON.stringify(windows.at(-1)))
}
phase = "drain"; await sleep(20000); out.end(); console.log("done")
