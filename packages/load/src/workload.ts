// ephem-load's pure half: the target, the safety limits, run validation, the per-region shard plan, and the request
// builders for every workload. No I/O here, so test/workload.test.ts covers all of it. The Worker (index.ts) only wires it to
// Durable Objects and fetch.
import park from "./park.json" with { type: "json" }

/** The only origin a generator ever contacts (requests and the colo probe). Nothing in a run spec can change it. */
export const ORIGIN = "https://ephem.ivar.workers.dev"

/** Durable Object location hints (developers.cloudflare.com/durable-objects/reference/data-location). */
export const REGIONS = ["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"] as const
export type Region = (typeof REGIONS)[number]

/** Request kinds. Each matches an existing laptop workload (guide "Remote load"). */
export const KINDS = ["position", "warm", "track", "weather", "search"] as const
export type Kind = (typeof KINDS)[number]

export const MODES = ["position", "warm", "track", "weather", "search", "mixed"] as const
export type Mode = (typeof MODES)[number]
export type Mix = Readonly<Partial<Record<Kind, number>>>
/** mixed: mostly cheap live/warm traffic, a little uncached compute, 1% scans (a scan is ~1 s CPU over 14 windows). */
export const MIXED: Mix = { position: 40, warm: 30, track: 15, weather: 14, search: 1 }
export const mixOf = (mode: Mode): Mix => (mode === "mixed" ? MIXED : { [mode]: 1 })

/**
 * Hard limits, enforced by the Worker on every run (the CLI only pre-checks them). They make ephem-load useless as a DoS
 * tool: one target, a total rate and duration cap, a per-run and per-hour request budget, one run at a time, a scan cap
 * (scans are the expensive route), and a per-shard in-flight cap (an arrival over it is dropped and counted, never queued).
 */
export const LIMITS = {
  maxRate: 300, // req/s, all regions together
  maxSearchRate: 4, // scans/s, all regions together (124/min was the 2026-10-30 A/B's contention level)
  maxDurationS: 600,
  maxRequestsPerRun: 60_000,
  maxRequestsPerHour: 150_000, // rolling, over every run the coordinator admitted
  maxRegions: 5,
  maxRatePerRegion: 64, // maxShardsPerRegion x shardRate
  /** Planning: one Generator's fetches through the public front door serialise at ~6.5 req/s (2026-10-30, position only, one
   * shard in enam: 3/s p50 11 ms p99 220 ms; 8/s → 6.3/s answered, p50 507 ms; 15/s → 6.7/s, p50 859 ms), so a shard is planned
   * well under it. (db-load drives ~22/s per DO to a custom domain without global_fetch_strictly_public.) */
  shardRate: 4,
  shardSearchRate: 1.5,
  maxShardsPerRegion: 16,
  inflightPerShard: 6,
  timeoutMs: { search: 30_000, other: 10_000 } as const,
  samplePerKind: 150, // rays kept per shard and kind (client ms + ray, for the server-side join)
  defaultWarmupS: 10, // the 2026-10-30 validation run (no warmup): 52 of the 71 requests with > 200 ms client-side overhead were in its first 5 s
  maxWarmupS: 60,
  startLeadMs: 8_000, // every shard starts at the same instant, this far after POST /run (prewarm happens before it)
  lateMs: 50, // an arrival sent this much after its scheduled instant counts as late (generator-side lag, not ephem's)
} as const

export interface RunSpec {
  readonly runId: string
  readonly mode: Mode
  readonly mix: Mix
  /** Total offered rate, req/s, split evenly over the regions. */
  readonly rate: number
  /** Measured seconds, after the warmup. */
  readonly durationS: number
  /** Seconds of the same schedule before the measured window, counted apart (new connections, cold isolates in each colo). */
  readonly warmupS: number
  readonly regions: readonly Region[]
  readonly seed: number
  /** ephem version id pinned with Cloudflare-Workers-Version-Overrides, or null. */
  readonly pin: string | null
  /** Epoch ms at which every shard starts its open-loop schedule (the warmup); the measured window is measureFrom(spec) on. */
  readonly startAt: number
  /** Shards per region asked for (never fewer than the plan needs), or null for the plan's own count. */
  readonly shards: number | null
}

export const measureFrom = (spec: Pick<RunSpec, "startAt" | "warmupS">): number => spec.startAt + spec.warmupS * 1000
export const endOf = (spec: Pick<RunSpec, "startAt" | "warmupS" | "durationS">): number => measureFrom(spec) + spec.durationS * 1000

export const RUN_ID = /^[0-9A-Za-z_-]{1,48}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export const makeRunId = (now: number, rand: () => number): string =>
  `L${new Date(now).toISOString().replace(/[-:]/g, "").slice(0, 15)}Z-${Math.floor(rand() * 36 ** 4).toString(36).padStart(4, "0")}`

/** Σ weights, and the scan share of the rate. */
const total = (mix: Mix): number => KINDS.reduce((s, k) => s + (mix[k] ?? 0), 0)
export const searchRate = (spec: Pick<RunSpec, "mix" | "rate">): number => (spec.rate * (spec.mix.search ?? 0)) / total(spec.mix)

const fail = (reason: string) => ({ ok: false as const, reason })

/** Validates an untrusted POST /run body. Every limit above is checked here; the Worker refuses anything else. */
export const validate = (body: unknown, now: number, rand: () => number): { ok: true; spec: RunSpec } | { ok: false; reason: string } => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return fail("body must be a JSON object")
  const b = body as Record<string, unknown>
  const known = new Set(["runId", "mode", "mix", "rate", "duration", "warmup", "regions", "seed", "pin", "shards"])
  const extra = Object.keys(b).filter(k => !known.has(k))
  if (extra.length) return fail(`unknown field(s) ${extra.join(", ")} (there is no target, host, path or header field: the target is fixed)`)
  const mode = b.mode
  if (typeof mode !== "string" || !(MODES as readonly string[]).includes(mode)) return fail(`mode must be one of ${MODES.join(", ")}`)
  let mix = mixOf(mode as Mode)
  if (b.mix !== undefined) {
    if (mode !== "mixed") return fail("mix is only for mode mixed")
    if (b.mix === null || typeof b.mix !== "object" || Array.isArray(b.mix)) return fail("mix must be {kind: weight}")
    const m: Partial<Record<Kind, number>> = {}
    for (const [k, w] of Object.entries(b.mix as Record<string, unknown>)) {
      if (!(KINDS as readonly string[]).includes(k)) return fail(`mix kind ${k} is not one of ${KINDS.join(", ")}`)
      if (typeof w !== "number" || !Number.isFinite(w) || w < 0 || w > 1000) return fail(`mix weight for ${k} must be 0..1000`)
      m[k as Kind] = w
    }
    if (total(m) <= 0) return fail("mix weights sum to 0")
    mix = m
  }
  const rate = b.rate, duration = b.duration
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) return fail("rate must be a positive number (req/s)")
  if (rate > LIMITS.maxRate) return fail(`rate ${rate} req/s is over the cap of ${LIMITS.maxRate} req/s`)
  if (typeof duration !== "number" || !Number.isInteger(duration) || duration < 1) return fail("duration must be a positive integer (s)")
  if (duration > LIMITS.maxDurationS) return fail(`duration ${duration} s is over the cap of ${LIMITS.maxDurationS} s`)
  const warmup = b.warmup ?? LIMITS.defaultWarmupS
  if (typeof warmup !== "number" || !Number.isInteger(warmup) || warmup < 0 || warmup > LIMITS.maxWarmupS) return fail(`warmup must be an integer 0..${LIMITS.maxWarmupS} (s)`)
  if (rate * (duration + warmup) > LIMITS.maxRequestsPerRun) return fail(`rate x (warmup + duration) = ${Math.round(rate * (duration + warmup))} requests is over the per-run cap of ${LIMITS.maxRequestsPerRun}`)
  const sr = searchRate({ mix, rate })
  if (sr > LIMITS.maxSearchRate + 1e-9) return fail(`scan rate ${sr.toFixed(2)}/s is over the cap of ${LIMITS.maxSearchRate}/s (${LIMITS.maxSearchRate * 60}/min); a scan is ~1 s of CPU`)
  if (!Array.isArray(b.regions) || b.regions.length === 0) return fail(`regions must be a non-empty list of ${REGIONS.join(", ")}`)
  if (b.regions.length > LIMITS.maxRegions) return fail(`at most ${LIMITS.maxRegions} regions`)
  for (const r of b.regions) if (typeof r !== "string" || !(REGIONS as readonly string[]).includes(r)) return fail(`region ${String(r)} is not one of ${REGIONS.join(", ")}`)
  if (new Set(b.regions).size !== b.regions.length) return fail("regions repeat")
  if (rate / b.regions.length > LIMITS.maxRatePerRegion) return fail(`${(rate / b.regions.length).toFixed(1)} req/s per region is over the cap of ${LIMITS.maxRatePerRegion} (${LIMITS.maxShardsPerRegion} shards x ${LIMITS.shardRate}/s): add regions`)
  const shards = b.shards ?? null
  if (shards !== null && (typeof shards !== "number" || !Number.isInteger(shards) || shards < 1 || shards > LIMITS.maxShardsPerRegion)) return fail(`shards must be an integer 1..${LIMITS.maxShardsPerRegion}`)
  const seed = b.seed ?? 1
  if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0 || seed > 2 ** 31) return fail("seed must be an integer 0..2^31")
  const pin = b.pin ?? null
  if (pin !== null && (typeof pin !== "string" || !UUID.test(pin))) return fail("pin must be a full ephem version id (uuid)")
  const runId = b.runId ?? makeRunId(now, rand)
  if (typeof runId !== "string" || !RUN_ID.test(runId)) return fail(`runId must match ${RUN_ID}`)
  return { ok: true, spec: { runId, mode: mode as Mode, mix, rate, durationS: duration, regions: b.regions as Region[], seed, pin, warmupS: warmup, startAt: now + LIMITS.startLeadMs, shards } }
}

export interface ShardPlan {
  readonly region: Region
  readonly shard: number
  readonly shards: number
  /** This shard's offered rate, req/s. */
  readonly rate: number
  readonly seed: number
}

/** The rate is split evenly over the regions, and a region's share over enough shards to stay under one invocation's ceiling. */
export const plan = (spec: RunSpec): ShardPlan[] => {
  const perRegion = spec.rate / spec.regions.length
  const scanPerRegion = searchRate(spec) / spec.regions.length
  const need = Math.max(1, Math.ceil(perRegion / LIMITS.shardRate - 1e-9), Math.ceil(scanPerRegion / LIMITS.shardSearchRate - 1e-9))
  const shards = Math.min(LIMITS.maxShardsPerRegion, Math.max(need, spec.shards ?? 0))
  return spec.regions.flatMap((region, ri) =>
    Array.from({ length: shards }, (_, shard) => ({ region, shard, shards, rate: perRegion / shards, seed: ((spec.seed * 31 + ri) * 1009 + shard) >>> 0 })))
}

/** Seeded PRNG (mulberry32): a run is reproducible from its seed. */
export const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Weighted pick of the next request's kind. */
export const picker = (mix: Mix): ((u: number) => Kind) => {
  const ks = KINDS.filter(k => (mix[k] ?? 0) > 0), t = total(mix)
  return u => {
    let acc = 0
    for (const k of ks) { acc += (mix[k] ?? 0) / t; if (u < acc) return k }
    return ks[ks.length - 1]!
  }
}

export interface Built {
  readonly kind: Kind
  readonly method: "GET" | "POST"
  /** Path + query. Always one of the fixed routes below; the URL is always ORIGIN + path. */
  readonly path: string
  readonly body?: string
}

const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z")
const fx = (x: number, d: number) => x.toFixed(d)

/** 24 deterministic keys (split-ab/load.ts's warm set): every shard GETs each once before the start, then cycles them (HITs). */
export const WARM_KEYS: readonly string[] = Array.from({ length: 8 }, (_, i) => {
  const d = String(i + 1).padStart(2, "0"), e = String(i + 2).padStart(2, "0")
  return [
    `/v1/day?lat=40.7&lon=-74&date=2026-11-${d}&tz=America/New_York`,
    `/v1/track?lat=40.7&lon=-74&start=2026-11-${d}T00:00:00Z&end=2026-11-${e}T00:00:00Z`,
    `/v1/alignment?body=moon&targetLat=40.68925&targetLon=-74.0445&targetHeight=63.4&start=2026-11-${d}T02:00:00Z&end=2026-11-${d}T03:00:00Z`,
  ]
}).flat()

/** load.sh LOAD=weather's land-weighted boxes: [lat0, lat1, lon0, lon1]. */
const BOXES: ReadonlyArray<readonly [number, number, number, number]> = [
  [25, 49, -124, -67], [36, 60, -10, 30], [-38, -12, 114, 153], [20, 45, 100, 145], [-35, 5, -75, -35], [40, 70, -170, -60], [-60, 80, -180, 180],
]

/**
 * One request of a kind. `rand` is the shard's seeded PRNG, `i` the arrival index, `now` epoch ms.
 *   position  GET /v1/position (live, no time: computed in the front door), split-ab's probe
 *   warm      GET one of WARM_KEYS (pre-warmed: Workers Caching HITs)
 *   track     GET /v1/track, homepage-shaped (72 h from a UTC midnight, default 20-min grid) at a fresh lat/lon (load.sh LOAD=track)
 *   weather   GET /v1/weather at a random land-weighted lat/lon, n = 1..3 (load.sh LOAD=weather)
 *   search    POST /v1/alignment/search, 12-month Brooklyn Bridge Park scan at a fresh target height (split-ab's cold scan)
 */
export const build = (kind: Kind, rand: () => number, i: number, now: number): Built => {
  switch (kind) {
    case "position": return { kind, method: "GET", path: "/v1/position?lat=40.7&lon=-74" }
    case "warm": return { kind, method: "GET", path: WARM_KEYS[i % WARM_KEYS.length]! }
    case "track": {
      const lat = -60 + 120 * rand(), lon = -180 + 360 * rand()
      const d = (Math.floor(now / DAY) - 1 + Math.floor(rand() * 3)) * DAY
      return { kind, method: "GET", path: `/v1/track?lat=${fx(lat, 4)}&lon=${fx(lon, 4)}&start=${iso(d)}&end=${iso(d + 3 * DAY)}` }
    }
    case "weather": {
      const [la0, la1, lo0, lo1] = BOXES[Math.floor(rand() * BOXES.length)]!
      return { kind, method: "GET", path: `/v1/weather?lat=${fx(la0 + (la1 - la0) * rand(), 3)}&lon=${fx(lo0 + (lo1 - lo0) * rand(), 3)}&n=${1 + Math.floor(rand() * 3)}` }
    }
    case "search": {
      const body = { body: "moon", target: { lat: 40.68925, lon: -74.0445, height: 71 + rand(), heightRef: "msl" }, region: park, observerHeight: 5, heightRef: "msl", start: "2026-10-30T00:00:00Z", end: "2027-10-30T00:00:00Z" }
      return { kind, method: "POST", path: "/v1/alignment/search", body: JSON.stringify(body) }
    }
  }
}

/** The URL of a built request; throws unless it is on ORIGIN (defence in depth: paths are built above, never taken from input). */
export const target = (path: string): URL => {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error(`refused: ${path} is not a path`)
  const u = new URL(path, ORIGIN)
  if (u.origin !== ORIGIN) throw new Error(`refused: ${u.origin} is not ${ORIGIN}`)
  return u
}

/** Headers on every generated request: x-ephem-load tags the run (o11y filter; request rows say ua_family "synthetic"). */
export const headers = (spec: Pick<RunSpec, "runId" | "pin">, built: Built): Record<string, string> => ({
  "x-ephem-load": spec.runId,
  "user-agent": `ephem-load/1 (run ${spec.runId})`,
  ...(built.body !== undefined ? { "content-type": "application/json" } : {}),
  ...(spec.pin !== null ? { "cloudflare-workers-version-overrides": `ephem="${spec.pin}"` } : {}),
})

/** The colo that answered, from cf-ray ("8d…-EWR"). */
export const rayColo = (ray: string | null): string => (ray && /-[A-Z]{3}$/.test(ray) ? ray.slice(-3) : "?")
