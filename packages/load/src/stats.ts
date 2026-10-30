// Client-side latency stats: a log histogram (1 % buckets, mergeable, JSON-safe over RPC) and per-kind counters. Shards
// record; the Worker merges shards into regions and regions into totals.
import { KINDS, LIMITS, type Kind } from "./workload.ts"

const G = Math.log(1.01)
/** Sparse log histogram: bucket b holds values in (1.01^(b-1), 1.01^b] ms; b = 0 holds everything ≤ 1 ms. Quantiles are within 1 %. */
export interface Hist { counts: Record<string, number>; n: number; sum: number; max: number }
export const hist = (): Hist => ({ counts: {}, n: 0, sum: 0, max: 0 })
export const bucketOf = (ms: number): number => (ms <= 1 ? 0 : Math.ceil(Math.log(ms) / G))
const upper = (b: number): number => (b === 0 ? 1 : Math.exp(b * G))
export const add = (h: Hist, ms: number): void => {
  const b = String(bucketOf(ms)); h.counts[b] = (h.counts[b] ?? 0) + 1; h.n++; h.sum += ms; if (ms > h.max) h.max = ms
}
export const mergeHist = (into: Hist, h: Hist): void => {
  for (const [b, c] of Object.entries(h.counts)) into.counts[b] = (into.counts[b] ?? 0) + c
  into.n += h.n; into.sum += h.sum; into.max = Math.max(into.max, h.max)
}
/** The q-quantile: the upper edge of the bucket holding the ceil(q·n)-th value (capped at the exact max). */
export const quantile = (h: Hist, q: number): number | null => {
  if (h.n === 0) return null
  const rank = Math.max(1, Math.ceil(q * h.n)); let seen = 0
  for (const b of Object.keys(h.counts).map(Number).toSorted((x, y) => x - y)) {
    seen += h.counts[String(b)]!
    if (seen >= rank) return Math.min(h.max, Math.round(upper(b) * 10) / 10)
  }
  return h.max
}

type Counts = Record<string, number>
const bump = (c: Counts, k: string, n = 1) => { c[k] = (c[k] ?? 0) + n }
const mergeCounts = (into: Counts, c: Counts) => { for (const [k, n] of Object.entries(c)) bump(into, k, n) }

/** One kind's counters on one shard (or merged). `sample`: [ray, client ms, status, sent at (ms after the start)] for the
 * server-side join (scripts/obs/load-check.py). */
export interface KindStats {
  offered: number; dropped: number; completed: number; ok: number
  status: Counts; errors: Counts; cache: Counts; served: Counts; versions: Counts; pinMiss: number
  hist: Hist; sample: Array<[string, number, number, number]>
}
export const kindStats = (): KindStats => ({ offered: 0, dropped: 0, completed: 0, ok: 0, status: {}, errors: {}, cache: {}, served: {}, versions: {}, pinMiss: 0, hist: hist(), sample: [] })
export type ShardStats = { kinds: Record<Kind, KindStats>; maxLagMs: number; late: number; prewarm: { sent: number; ok: number } }
export const shardStats = (): ShardStats => ({ kinds: Object.fromEntries(KINDS.map(k => [k, kindStats()])) as Record<Kind, KindStats>, maxLagMs: 0, late: 0, prewarm: { sent: 0, ok: 0 } })

export interface Outcome { status: number; ms: number; at: number; ray: string | null; colo: string; cache: string | null; version: string | null; error?: string }
/** Record one completed request. A pinned run counts every answer not from the pinned version. `sample` is a uniform
 * reservoir (Algorithm R) over the answered requests, so it spans the whole run, not its first seconds. */
export const record = (s: KindStats, o: Outcome, pin: string | null, rand: () => number = Math.random): void => {
  s.completed++
  if (o.error !== undefined) { bump(s.errors, o.error); return }
  bump(s.status, String(o.status)); if (o.status < 400) s.ok++
  add(s.hist, o.ms)
  bump(s.served, o.colo); bump(s.cache, o.cache ?? "-"); bump(s.versions, (o.version ?? "-").slice(0, 8))
  if (pin !== null && o.version !== pin) s.pinMiss++
  if (o.ray === null) return
  const row: [string, number, number, number] = [o.ray, Math.round(o.ms), o.status, Math.round(o.at)]
  if (s.sample.length < LIMITS.samplePerKind) s.sample.push(row)
  else { const j = Math.floor(rand() * s.hist.n); if (j < LIMITS.samplePerKind) s.sample[j] = row }
}

export const mergeKind = (into: KindStats, s: KindStats, sampleCap: number): void => {
  into.offered += s.offered; into.dropped += s.dropped; into.completed += s.completed; into.ok += s.ok; into.pinMiss += s.pinMiss
  mergeCounts(into.status, s.status); mergeCounts(into.errors, s.errors); mergeCounts(into.cache, s.cache); mergeCounts(into.served, s.served); mergeCounts(into.versions, s.versions)
  mergeHist(into.hist, s.hist)
  for (const x of s.sample) if (into.sample.length < sampleCap) into.sample.push(x)
}

/** What GET /run/:id reports per (region, kind) and per kind: counts, client latency percentiles (ms), mixes. */
export interface KindSummary {
  offered: number; dropped: number; completed: number; ok: number; errors: Counts; status: Counts; cache: Counts; served: Counts; versions: Counts; pinMiss: number
  ms: { p50: number | null; p90: number | null; p99: number | null; max: number | null; mean: number | null }
  sample?: Array<[string, number, number, number]>
}
export const summarize = (s: KindStats, withSample: boolean): KindSummary => ({
  offered: s.offered, dropped: s.dropped, completed: s.completed, ok: s.ok, errors: s.errors, status: s.status, cache: s.cache, served: s.served, versions: s.versions, pinMiss: s.pinMiss,
  ms: { p50: quantile(s.hist, 0.5), p90: quantile(s.hist, 0.9), p99: quantile(s.hist, 0.99), max: s.hist.n ? Math.round(s.hist.max) : null, mean: s.hist.n ? Math.round((s.hist.sum / s.hist.n) * 10) / 10 : null },
  ...(withSample ? { sample: s.sample } : {}),
})
