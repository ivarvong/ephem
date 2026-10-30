// ephem-load: open-loop load at ephem from inside Cloudflare, in several regions at once, so A/Bs stop depending on one laptop's
// link (guide "Remote load"). The pattern is db-load's (~/code/db/bench/worker): a run is `shards` Generator Durable Objects per
// region, each created with a location hint; each runs its share of the schedule in an alarm and records client latencies;
// GET /run/:id merges them. The Coordinator (one object) admits runs: one at a time, inside the per-hour request budget.
//   GET  /health              no auth: service, colo, target, limits
//   POST /plan                the validated spec and shard plan, nothing started
//   POST /run                 {mode, rate, duration, regions, seed?, pin?, mix?, runId?} -> starts every shard at one instant
//   GET  /run/:id[?sample=1]  merged report (per region x kind, per kind), done once every shard finished; sample=1 adds up to
//                             600 [ray, client ms, status] per region and kind (scripts/obs/load-check.py joins them to spans)
//   POST /run/:id/stop        stop every shard now (the CLI sends it on Ctrl-C)
//   GET  /runs                recent runs
// Bearer LOAD_TOKEN (a Workers secret) on everything but /health; without the secret every call is refused.
import { DurableObject } from "cloudflare:workers"
import { type KindStats, type KindSummary, type Outcome, type ShardStats, kindStats, mergeKind, record, shardStats, summarize } from "./stats.ts"
import { KINDS, LIMITS, ORIGIN, REGIONS, RUN_ID, WARM_KEYS, build, headers, mulberry32, picker, plan, rayColo, target, validate, type Kind, type Region, type RunSpec, type ShardPlan } from "./workload.ts"

interface Env { readonly LOAD_TOKEN?: string; readonly VERSION?: { readonly id: string } }
interface Exports { readonly Generator: DurableObjectNamespace<Generator>; readonly Coordinator: DurableObjectNamespace<Coordinator> }
interface Ctx { waitUntil(p: Promise<unknown>): void; readonly exports: Exports }

type State = "pending" | "running" | "done" | "failed"
export interface ShardConfig { readonly spec: RunSpec; readonly plan: ShardPlan }
export interface ShardReport {
  readonly region: Region; readonly shard: number; readonly state: State; readonly colo: string
  readonly startedAt: number | null; readonly endedAt: number | null; readonly error: string | null; readonly stats: ShardStats | null
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, Math.max(0, ms)))
const errName = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e))

/** The generator's own colo: ephem's host answers /cdn-cgi/trace at the edge (the Worker never runs), so even this probe stays on ORIGIN. */
async function whereAmI(): Promise<string> {
  try {
    const t = await (await fetch(target("/cdn-cgi/trace"), { signal: AbortSignal.timeout(5000), redirect: "manual" })).text()
    return /^colo=(\w+)$/m.exec(t)?.[1] ?? "?"
  } catch { return "?" }
}

/** One request against ephem, timed from just before fetch to the last body byte. */
async function fire(spec: RunSpec, kind: Kind, path: string, method: "GET" | "POST", body: string | undefined): Promise<Outcome> {
  const url = target(path)
  const t0 = Date.now()
  try {
    const r = await fetch(url, { method, headers: headers(spec, { kind, method, path, ...(body !== undefined ? { body } : {}) }), ...(body !== undefined ? { body } : {}), redirect: "manual", signal: AbortSignal.timeout(kind === "search" ? LIMITS.timeoutMs.search : LIMITS.timeoutMs.other) })
    await r.arrayBuffer()
    const ray = r.headers.get("cf-ray")
    return { status: r.status, ms: Date.now() - t0, ray, colo: rayColo(ray), cache: r.headers.get("x-ephem-cache"), version: r.headers.get("x-ephem-version") }
  } catch (e) {
    const name = e instanceof Error ? e.name : "Error"
    return { status: 0, ms: Date.now() - t0, ray: null, colo: "?", cache: null, version: null, error: name === "TimeoutError" || name === "AbortError" ? "timeout" : name }
  }
}

export class Generator extends DurableObject<Env> {
  private live: { runId: string; stats: ShardStats; stop: boolean } | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS runs (runId TEXT PRIMARY KEY, config TEXT NOT NULL, state TEXT NOT NULL, colo TEXT NOT NULL DEFAULT '?',
      startedAt INTEGER, endedAt INTEGER, stats TEXT, error TEXT, created INTEGER NOT NULL)`)
  }

  /** Record the run and set the alarm (the alarm does the work, so this returns at once). Idempotent per run (retried RPCs). */
  async start(cfg: ShardConfig): Promise<{ ok: true }> {
    const sql = this.ctx.storage.sql
    if (sql.exec(`SELECT 1 FROM runs WHERE runId = ?`, cfg.spec.runId).toArray().length) return { ok: true }
    const busy = sql.exec<{ runId: string }>(`SELECT runId FROM runs WHERE state IN ('pending', 'running')`).toArray()[0]
    if (busy) throw new Error(`generator busy with run ${busy.runId}`)
    // Defence in depth: the Worker validated the spec; the shard re-checks its own share.
    if (cfg.plan.rate > LIMITS.shardRate * 1.5 || cfg.spec.durationS > LIMITS.maxDurationS) throw new Error("shard config over the limits")
    sql.exec(`INSERT INTO runs (runId, config, state, created) VALUES (?, ?, 'pending', ?)`, cfg.spec.runId, JSON.stringify(cfg), Date.now())
    await this.ctx.storage.setAlarm(Date.now() + 20)
    return { ok: true }
  }

  stop(runId: string): { ok: boolean } {
    if (this.live?.runId === runId) { this.live.stop = true; return { ok: true } }
    this.ctx.storage.sql.exec(`UPDATE runs SET state = 'failed', error = 'stopped before start' WHERE runId = ? AND state = 'pending'`, runId)
    return { ok: false }
  }

  async alarm(): Promise<void> {
    const sql = this.ctx.storage.sql
    // 'running' with nothing live in memory: the object restarted mid-run, the measurement is lost; say so.
    for (const r of sql.exec<{ runId: string }>(`SELECT runId FROM runs WHERE state = 'running'`).toArray())
      if (this.live?.runId !== r.runId) sql.exec(`UPDATE runs SET state = 'failed', error = 'interrupted: object restarted during the run', endedAt = ? WHERE runId = ?`, Date.now(), r.runId)
    const row = sql.exec<{ runId: string; config: string }>(`SELECT runId, config FROM runs WHERE state = 'pending' ORDER BY created LIMIT 1`).toArray()[0]
    if (!row) return
    const cfg = JSON.parse(row.config) as ShardConfig
    const colo = await whereAmI()
    sql.exec(`UPDATE runs SET state = 'running', colo = ? WHERE runId = ?`, colo, row.runId)
    const live = { runId: row.runId, stats: shardStats(), stop: false }
    this.live = live
    try {
      await this.drive(cfg, live)
      sql.exec(`UPDATE runs SET state = 'done', stats = ?, endedAt = ? WHERE runId = ?`, JSON.stringify(live.stats), Date.now(), row.runId)
    } catch (e) {
      console.error(JSON.stringify({ generator_failed: { run: row.runId, region: cfg.plan.region, shard: cfg.plan.shard, error: errName(e) } }))
      sql.exec(`UPDATE runs SET state = 'failed', error = ?, stats = ?, endedAt = ? WHERE runId = ?`, errName(e), JSON.stringify(live.stats), Date.now(), row.runId)
    } finally {
      this.live = null
    }
  }

  /** Prewarm (warm keys, before the start), then the open-loop schedule: arrival i at startAt + (i + shard/shards) / rate. An
   * arrival that finds the in-flight cap full is dropped and counted (`dropped`), never queued, so latency stays honest. */
  private async drive(cfg: ShardConfig, live: { runId: string; stats: ShardStats; stop: boolean }): Promise<void> {
    const { spec, plan: p } = cfg
    const st = live.stats
    if ((spec.mix.warm ?? 0) > 0) {
      for (const k of WARM_KEYS) {
        if (Date.now() > spec.startAt - 200) break
        st.prewarm.sent++
        const o = await fire(spec, "warm", k, "GET", undefined)
        if (o.error === undefined && o.status < 400) st.prewarm.ok++
      }
    }
    const rand = mulberry32(p.seed), pick = picker(spec.mix), period = 1000 / p.rate, phase = (p.shard / p.shards) * period
    const end = spec.startAt + spec.durationS * 1000
    this.ctx.storage.sql.exec(`UPDATE runs SET startedAt = ? WHERE runId = ?`, spec.startAt, spec.runId)
    const inflight = new Set<Promise<void>>()
    for (let i = 0; ; i++) {
      const at = spec.startAt + phase + i * period
      if (at >= end || live.stop) break
      await sleep(at - Date.now())
      if (live.stop) break
      st.maxLagMs = Math.max(st.maxLagMs, Date.now() - at)
      const kind = pick(rand()), s: KindStats = st.kinds[kind]
      s.offered++
      if (inflight.size >= LIMITS.inflightPerShard) { s.dropped++; continue }
      const b = build(kind, rand, i, Date.now())
      const job: Promise<void> = fire(spec, kind, b.path, b.method, b.body).then(o => { record(s, o, spec.pin, rand) }).finally(() => { inflight.delete(job) })
      inflight.add(job)
    }
    await Promise.allSettled(inflight)
  }

  report(runId: string): ShardReport | null {
    const row = this.ctx.storage.sql.exec<{ config: string; state: State; colo: string; startedAt: number | null; endedAt: number | null; stats: string | null; error: string | null }>(
      `SELECT config, state, colo, startedAt, endedAt, stats, error FROM runs WHERE runId = ?`, runId).toArray()[0]
    if (!row) return null
    const cfg = JSON.parse(row.config) as ShardConfig
    const stats = this.live?.runId === runId ? this.live.stats : row.stats === null ? null : (JSON.parse(row.stats) as ShardStats)
    return { region: cfg.plan.region, shard: cfg.plan.shard, state: row.state, colo: row.colo, startedAt: row.startedAt, endedAt: row.endedAt, error: row.error, stats }
  }
}

interface RunRow { runId: string; spec: string; shards: number; requests: number; created: number; endsAt: number; stopped: number }

/** One object for the whole Worker: admits a run only when no other run is live and the rolling hour has budget left. */
export class Coordinator extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS runs (runId TEXT PRIMARY KEY, spec TEXT NOT NULL, shards INTEGER NOT NULL, requests INTEGER NOT NULL,
      created INTEGER NOT NULL, endsAt INTEGER NOT NULL, stopped INTEGER NOT NULL DEFAULT 0)`)
  }

  admit(spec: RunSpec, shards: number): { ok: true } | { ok: false; reason: string } {
    const sql = this.ctx.storage.sql, now = Date.now(), requests = Math.ceil(spec.rate * spec.durationS)
    if (sql.exec(`SELECT 1 FROM runs WHERE runId = ?`, spec.runId).toArray().length) return { ok: false, reason: `run ${spec.runId} exists` }
    const live = sql.exec<{ runId: string; endsAt: number }>(`SELECT runId, endsAt FROM runs WHERE stopped = 0 AND endsAt > ?`, now).toArray()[0]
    if (live) return { ok: false, reason: `run ${live.runId} is live until ${new Date(live.endsAt).toISOString()} (one run at a time; POST /run/${live.runId}/stop to end it)` }
    const hour = sql.exec<{ n: number | null }>(`SELECT SUM(requests) AS n FROM runs WHERE created > ?`, now - 3_600_000).toArray()[0]?.n ?? 0
    if (hour + requests > LIMITS.maxRequestsPerHour) return { ok: false, reason: `hourly budget: ${hour} requests admitted in the last hour + ${requests} > ${LIMITS.maxRequestsPerHour}` }
    const endsAt = spec.startAt + spec.durationS * 1000 + LIMITS.timeoutMs.search
    sql.exec(`INSERT INTO runs (runId, spec, shards, requests, created, endsAt) VALUES (?, ?, ?, ?, ?, ?)`, spec.runId, JSON.stringify(spec), shards, requests, now, endsAt)
    return { ok: true }
  }

  get(runId: string): { spec: RunSpec; shards: number; stopped: boolean } | null {
    const r = this.ctx.storage.sql.exec<RunRow>(`SELECT * FROM runs WHERE runId = ?`, runId).toArray()[0]
    return r ? { spec: JSON.parse(r.spec) as RunSpec, shards: r.shards, stopped: r.stopped === 1 } : null
  }

  stop(runId: string): void { this.ctx.storage.sql.exec(`UPDATE runs SET stopped = 1, endsAt = MIN(endsAt, ?) WHERE runId = ?`, Date.now(), runId) }

  list(): Array<{ runId: string; mode: string; rate: number; durationS: number; regions: readonly string[]; created: string; stopped: boolean }> {
    return this.ctx.storage.sql.exec<RunRow>(`SELECT * FROM runs ORDER BY created DESC LIMIT 20`).toArray().map(r => {
      const s = JSON.parse(r.spec) as RunSpec
      return { runId: r.runId, mode: s.mode, rate: s.rate, durationS: s.durationS, regions: s.regions, created: new Date(r.created).toISOString(), stopped: r.stopped === 1 }
    })
  }
}

// ---------------------------------------------------------------- Worker

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })
const utf8 = new TextEncoder()
const authorized = (header: string | null, token: string | undefined): boolean => {
  if (!token || !header?.startsWith("Bearer ")) return false
  const a = utf8.encode(header.slice(7)), b = utf8.encode(token)
  return a.byteLength === b.byteLength && (crypto.subtle as unknown as { timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean }).timingSafeEqual(a, b)
}
/** A stub call that meets a restarting object rejects; start/stop are idempotent and reports are reads, so retry a few times. */
async function retried<T>(fn: () => Promise<T>, tries = 4): Promise<T> {
  for (let n = 1; ; n++) {
    try { return await fn() } catch (e) { if (n >= tries) throw e; await sleep(250 * n) }
  }
}
// A fresh object per (run, region, shard): a location hint only applies when the object is created.
const gen = (x: Exports, runId: string, region: Region, shard: number) => x.Generator.get(x.Generator.idFromName(`${runId}:${region}:${shard}`), { locationHint: region })
const coordinator = (x: Exports) => x.Coordinator.get(x.Coordinator.idFromName("global"))

const fold = (reports: readonly ShardReport[], withSample: boolean, sampleCap: number) => {
  const kinds = Object.fromEntries(KINDS.map(k => [k, kindStats()])) as Record<Kind, KindStats>
  let maxLagMs = 0
  const prewarm = { sent: 0, ok: 0 }
  for (const r of reports) {
    if (!r.stats) continue
    for (const k of KINDS) mergeKind(kinds[k], r.stats.kinds[k], sampleCap)
    maxLagMs = Math.max(maxLagMs, r.stats.maxLagMs); prewarm.sent += r.stats.prewarm.sent; prewarm.ok += r.stats.prewarm.ok
  }
  const out: Partial<Record<Kind, KindSummary>> = {}
  for (const k of KINDS) if (kinds[k].offered > 0) out[k] = summarize(kinds[k], withSample)
  return { kinds: out, maxLagMs, prewarm, merged: kinds }
}

async function report(x: Exports, runId: string, withSample: boolean): Promise<Response> {
  const run = await coordinator(x).get(runId)
  if (!run) return json({ ok: false, code: "E_NOT_FOUND", runId }, 404)
  const { spec, shards } = run
  const regions = []
  const all: ShardReport[] = []
  for (const region of spec.regions) {   // one region's shards at a time (db-load: hundreds of RPCs at once lost connections)
    const reports = (await Promise.all(Array.from({ length: shards }, (_, i) => retried(() => gen(x, runId, region, i).report(runId))))).filter((r): r is ShardReport => r !== null)
    all.push(...reports)
    const colos: Record<string, number> = {}
    for (const r of reports) colos[r.colo] = (colos[r.colo] ?? 0) + 1
    const state: State = reports.length < shards ? "pending" : reports.every(r => r.state === "done") ? "done" : reports.every(r => r.state === "done" || r.state === "failed") ? "failed" : reports.some(r => r.state === "running") ? "running" : "pending"
    const f = fold(reports, withSample, LIMITS.samplePerKind * 4)
    regions.push({ region, shards, state, generatorColos: colos, errors: reports.filter(r => r.error).map(r => `${r.shard}: ${r.error}`), maxLagMs: f.maxLagMs, prewarm: f.prewarm, kinds: f.kinds })
  }
  const done = regions.every(r => r.state === "done" || r.state === "failed") || (run.stopped && all.every(r => r.state !== "running"))
  return json({ ok: true, runId, done, stopped: run.stopped, spec, shards, window: { startAt: new Date(spec.startAt).toISOString(), endAt: new Date(spec.startAt + spec.durationS * 1000).toISOString() }, regions, totals: fold(all, false, 0).kinds })
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const r = await handle(request, env, ctx)
    if (env.VERSION?.id) r.headers.set("x-ephem-load-version", env.VERSION.id)
    return r
  },
}

async function handle(request: Request, env: Env, ctx: Ctx): Promise<Response> {
  const url = new URL(request.url), path = url.pathname, method = request.method
  const colo = (request as { cf?: { colo?: string } }).cf?.colo ?? "?"
  if (method === "GET" && path === "/health") return json({ ok: true, service: "ephem-load", version: env.VERSION?.id ?? null, colo, target: ORIGIN, regions: REGIONS, limits: LIMITS, configured: Boolean(env.LOAD_TOKEN) })
  if (!env.LOAD_TOKEN) return json({ ok: false, code: "E_NOT_CONFIGURED", reason: "LOAD_TOKEN secret is not set" }, 503)
  if (!authorized(request.headers.get("authorization"), env.LOAD_TOKEN)) return json({ ok: false, code: "E_AUTH" }, 401)
  const x = ctx.exports
  try {
    if (method === "POST" && (path === "/run" || path === "/plan")) {
      const v = validate(await request.json().catch(() => null), Date.now(), Math.random)
      if (!v.ok) return json({ ok: false, code: "E_LIMIT", reason: v.reason }, 400)
      const spec = v.spec, shards = plan(spec)
      const perRegion = shards.length / spec.regions.length
      if (path === "/plan") return json({ ok: true, spec, plan: shards })
      const admitted = await coordinator(x).admit(spec, perRegion)
      if (!admitted.ok) return json({ ok: false, code: "E_BUSY", reason: admitted.reason }, 409)
      try {
        for (const region of spec.regions)
          await Promise.all(shards.filter(s => s.region === region).map(s => retried(() => gen(x, spec.runId, region, s.shard).start({ spec, plan: s }))))
      } catch (e) {
        // Never leave a half-started run: stop whatever started and release the lock.
        await coordinator(x).stop(spec.runId)
        await Promise.allSettled(shards.map(s => gen(x, spec.runId, s.region, s.shard).stop(spec.runId)))
        return json({ ok: false, code: "E_START", reason: errName(e) }, 500)
      }
      console.log(JSON.stringify({ run_started: { run: spec.runId, mode: spec.mode, rate: spec.rate, duration: spec.durationS, regions: spec.regions, shards: perRegion, pin: spec.pin, via: colo } }))
      return json({ ok: true, runId: spec.runId, viaColo: colo, spec, shardsPerRegion: perRegion, startAt: new Date(spec.startAt).toISOString() })
    }
    const m = /^\/run\/([^/]+)(\/stop)?$/.exec(path)
    if (m && RUN_ID.test(m[1]!)) {
      const runId = m[1]!
      if (method === "GET" && !m[2]) return await report(x, runId, url.searchParams.get("sample") === "1")
      if (method === "POST" && m[2]) {
        const run = await coordinator(x).get(runId)
        if (!run) return json({ ok: false, code: "E_NOT_FOUND", runId }, 404)
        await coordinator(x).stop(runId)
        const r = await Promise.allSettled(run.spec.regions.flatMap(region => Array.from({ length: run.shards }, (_, i) => retried(() => gen(x, runId, region, i).stop(runId)))))
        return json({ ok: true, runId, stopped: r.filter(s => s.status === "fulfilled" && s.value.ok).length })
      }
    }
    if (method === "GET" && path === "/runs") return json({ ok: true, runs: await coordinator(x).list() })
    return json({ ok: false, code: "E_NOT_FOUND" }, 404)
  } catch (e) {
    console.error(JSON.stringify({ load_error: { path, error: errName(e) } }))
    return json({ ok: false, code: "E_INTERNAL", reason: errName(e) }, 500)
  }
}
