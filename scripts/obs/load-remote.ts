// Remote load: drive ephem from ephem-load's Generator Durable Objects in several regions (guide "Remote load").
//   node --experimental-strip-types scripts/obs/load-remote.ts --mode mixed --rate 60 --duration 60 --regions enam,weur,apac
//        [--pin ephem=<version id>] [--seed 1] [--mix position=40,warm=30,track=15,weather=14,search=1] [--run-id <id>]
//        [--shards N per region (more than the plan needs)] [--plan] [--json] [--quiet] [--base https://ephem-load.ivar.workers.dev]
// --mode   position | warm | track | weather | search | mixed       --rate  total req/s over all regions ("120/min" also works)
// --pin    every request carries Cloudflare-Workers-Version-Overrides: ephem="<id>"; the table counts answers from any other version
// --plan   print the validated spec and shard plan; start nothing
// Prints the run id and window at the start (for queue.py / cpu-by-version.py / load-check.py --from/--to), then the client
// table per region and kind. Writes $LOAD_DIR (default ./load-runs)/<run id>.json: the full report incl. the sampled rays.
// Token: EPHEM_LOAD_TOKEN, else ~/.config/ephem-load/token (never printed). Ctrl-C stops the run on every shard.
// Exit 0 when every region finished with no errors and (with --pin) no answer from another version.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const argv = process.argv.slice(2)
const flags = new Map<string, string>()
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!
  if (!a.startsWith("--")) { console.error(`unexpected argument ${a}`); process.exit(2) }
  const k = a.slice(2), v = argv[i + 1]
  if (v === undefined || v.startsWith("--")) flags.set(k, "1"); else { flags.set(k, v); i++ }
}
const known = new Set(["mode", "rate", "duration", "regions", "pin", "seed", "mix", "run-id", "plan", "json", "quiet", "base", "shards"])
for (const k of flags.keys()) if (!known.has(k)) { console.error(`unknown flag --${k}`); process.exit(2) }
const need = (k: string) => { const v = flags.get(k); if (v === undefined) { console.error(`--${k} is required (usage: head of ${path.basename(import.meta.filename)})`); process.exit(2) } return v }

const BASE = (flags.get("base") ?? "https://ephem-load.ivar.workers.dev").replace(/\/$/, "")
const rateText = need("rate")
const rate = /\/min$/.test(rateText) ? Number(rateText.replace(/\/min$/, "")) / 60 : Number(rateText.replace(/\/s$/, ""))
const pinText = flags.get("pin")
const pin = pinText === undefined ? undefined : pinText.replace(/^ephem=/, "").replace(/^"|"$/g, "")
const mix = flags.get("mix")
const body = {
  mode: need("mode"),
  rate: Math.round(rate * 1e6) / 1e6,
  duration: Number(need("duration")),
  regions: need("regions").split(",").map(s => s.trim()).filter(Boolean),
  ...(flags.has("seed") ? { seed: Number(flags.get("seed")) } : {}),
  ...(pin !== undefined ? { pin } : {}),
  ...(mix !== undefined ? { mix: Object.fromEntries(mix.split(",").map(p => { const [k, w] = p.split("="); return [k!.trim(), Number(w)] })) } : {}),
  ...(flags.has("run-id") ? { runId: flags.get("run-id") } : {}),
  ...(flags.has("shards") ? { shards: Number(flags.get("shards")) } : {}),
}
const quiet = flags.has("quiet")
const log = (s: string) => { if (!quiet) console.error(s) }

function token(): string {
  const env = process.env.EPHEM_LOAD_TOKEN
  if (env) return env.trim()
  const f = path.join(os.homedir(), ".config", "ephem-load", "token")
  try { const t = fs.readFileSync(f, "utf8").trim(); if (t) return t } catch { /* below */ }
  console.error(`EPHEM_LOAD_TOKEN is not set and ${f} is missing or empty`); process.exit(2)
}
const TOKEN = token()

async function call(method: string, p: string, b?: unknown): Promise<any> {
  for (let n = 1; ; n++) {
    try {
      const r = await fetch(BASE + p, { method, headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" }, ...(b !== undefined ? { body: JSON.stringify(b) } : {}), signal: AbortSignal.timeout(60_000) })
      const text = await r.text()
      let j: any
      try { j = JSON.parse(text) } catch { j = { ok: false, reason: text.slice(0, 300) } }
      if (!r.ok) { const e = new Error(`${method} ${p}: HTTP ${r.status} ${j.code ?? ""} ${j.reason ?? ""}`) as Error & { status: number }; e.status = r.status; throw e }
      return j
    } catch (e) {
      // Retry only transport failures and 5xx on reads; a 4xx (limits, auth, busy) is the answer.
      const st = (e as { status?: number }).status
      if (method !== "GET" || (st !== undefined && st < 500) || n >= 4) throw e
      await new Promise(r => setTimeout(r, 1500 * n))
    }
  }
}

type Summary = { offered: number; dropped: number; completed: number; ok: number; errors: Record<string, number>; status: Record<string, number>; cache: Record<string, number>; served: Record<string, number>; versions: Record<string, number>; pinMiss: number; ms: { p50: number | null; p90: number | null; p99: number | null; max: number | null; mean: number | null } }
const top = (c: Record<string, number>, n = 3) => Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(", ")
const pct = (c: Record<string, number>, k: string) => { const t = Object.values(c).reduce((a, b) => a + b, 0); return t ? `${Math.round((100 * (c[k] ?? 0)) / t)}%` : "-" }
const f = (x: number | null) => (x === null ? "-" : x >= 100 ? String(Math.round(x)) : x.toFixed(1))
const sumErr = (s: Summary) => Object.values(s.errors).reduce((a, b) => a + b, 0) + Object.entries(s.status).filter(([k]) => Number(k) >= 500).reduce((a, [, v]) => a + v, 0)

function table(rep: any): string {
  const H = ["region", "gen colo", "kind", "offered", "ok", "err", "drop", "req/s", "p50", "p90", "p99", "max", "HIT", "answered in", "version"]
  const rows: string[][] = []
  const dur = rep.spec.durationS
  for (const r of rep.regions) for (const [kind, s] of Object.entries(r.kinds as Record<string, Summary>))
    rows.push([r.region, top(r.generatorColos, 2), kind, String(s.offered), String(s.ok), String(sumErr(s)), String(s.dropped), (s.completed / dur).toFixed(1), f(s.ms.p50), f(s.ms.p90), f(s.ms.p99), f(s.ms.max), pct(s.cache, "HIT"), top(s.served), top(s.versions, 2) + (rep.spec.pin ? ` (pin misses ${s.pinMiss})` : "")])
  for (const [kind, s] of Object.entries(rep.totals as Record<string, Summary>))
    rows.push(["ALL", "", kind, String(s.offered), String(s.ok), String(sumErr(s)), String(s.dropped), (s.completed / dur).toFixed(1), f(s.ms.p50), f(s.ms.p90), f(s.ms.p99), f(s.ms.max), pct(s.cache, "HIT"), top(s.served, 4), top(s.versions, 2)])
  const w = H.map((h, i) => Math.max(h.length, ...rows.map(r => r[i]!.length)))
  const line = (r: string[]) => `| ${r.map((c, i) => c.padEnd(w[i]!)).join(" | ")} |`
  return [line(H), `|${w.map(n => "-".repeat(n + 2)).join("|")}|`, ...rows.map(line)].join("\n")
}

if (flags.has("plan")) {
  const p = await call("POST", "/plan", body)
  console.log(JSON.stringify(p, null, 2)); process.exit(0)
}
const start = await call("POST", "/run", body).catch((e: Error) => { console.error(e.message); process.exit(1) })
const runId: string = start.runId
const endAt = new Date(Date.parse(start.startAt) + body.duration * 1000).toISOString()
console.log(`run ${runId}: ${body.mode} ${body.rate} req/s x ${body.duration} s from ${body.regions.join(",")} (${start.shardsPerRegion} shards/region, via ${start.viaColo})${pin ? ` pinned ephem=${pin}` : ""}`)
console.log(`window ${start.startAt} .. ${endAt}`)
let stopping = false
process.on("SIGINT", () => {
  if (stopping) process.exit(130)
  stopping = true; console.error(`\nstopping ${runId} on every shard…`)
  call("POST", `/run/${runId}/stop`).then(r => console.error(`stopped ${r.stopped} shards`), e => console.error(String(e)))
})
await new Promise(r => setTimeout(r, Math.max(0, Date.parse(start.startAt) - Date.now())))
let rep: any
for (;;) {
  await new Promise(r => setTimeout(r, 5000))
  rep = await call("GET", `/run/${runId}`)
  const prog = rep.regions.map((r: any) => `${r.region}@${top(r.generatorColos, 1).split(" ")[0]}:${r.state} ${Object.values(r.kinds as Record<string, Summary>).reduce((a, s) => a + s.completed, 0)}`).join("  ")
  log(`[${new Date().toISOString().slice(11, 19)}] ${prog}`)
  if (rep.done) break
}
rep = await call("GET", `/run/${runId}?sample=1`)
await call("POST", `/run/${runId}/stop`).catch(() => undefined)   // every shard is done: release the one-run lock now, not at endsAt + 30 s
const dir = process.env.LOAD_DIR ?? "load-runs"
fs.mkdirSync(dir, { recursive: true })
const file = path.join(dir, `${runId}.json`)
fs.writeFileSync(file, JSON.stringify({ ...rep, base: BASE, controller: { startedAt: start.startAt, viaColo: start.viaColo } }, null, 1))
if (flags.has("json")) console.log(JSON.stringify(rep))
else console.log(table(rep))
const errs = rep.regions.flatMap((r: any) => r.errors.map((e: string) => `${r.region}/${e}`))
if (errs.length) console.log(`shard errors: ${errs.join("; ")}`)
const lag = Math.max(...rep.regions.map((r: any) => r.maxLagMs)), late = rep.regions.reduce((a: number, r: any) => a + (r.late ?? 0), 0)
const totals = Object.values(rep.totals as Record<string, Summary>)
const bad = totals.reduce((a, s) => a + sumErr(s), 0), miss = totals.reduce((a, s) => a + s.pinMiss, 0), drop = totals.reduce((a, s) => a + s.dropped, 0)
console.log(`run ${runId}: ${totals.reduce((a, s) => a + s.ok, 0)} ok, ${bad} errors/5xx, ${drop} dropped at the in-flight cap, ${late} sent late (> 50 ms after their slot; max lag ${lag} ms)${pin ? `, ${miss} answers not from the pinned version` : ""}; written to ${file}`)
console.log(`server side: python3 scripts/obs/load-check.py ${file}   (>= 5 min after the end for complete telemetry)`)
process.exit(errs.length || bad || (pin && miss) ? 1 : 0)
