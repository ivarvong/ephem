// Server-Timing for every front-door response, built from the spans the request already records (src/requestlog.ts keeps
// them), so the browser's PerformanceResourceTiming.serverTiming gives a per-request server breakdown with no backend join.
//   api;desc="HIT";dur=…      the Api loopback: its cf-cache-status and the api.fetch span's duration
//   blocks;desc="L1 n=2";dur= blocks.load: the cache path (L1 / HIT:2,MISS:1) and block count
//   geoid;desc="L1";dur=…     geoid.load
//   feed;desc="HIT";dur=…     metar.feed (the MetarFeed loopback)
//   trace;desc="00-<trace>-<server root span>-01"   when the request carried a valid traceparent (documents set their own)
//   ray;desc="<cf-ray>"       front door (src/requestlog.ts), first: joins a RUM resource row to its invocation
//   total;dur=…               added last by router.ts toHandler: the front door's I/O wall
// Durations are the Workers clock, which only advances on I/O (frozen during compute): they are I/O wall, never CPU. CPU is not
// readable inside a request, so no cpu entry is sent (a number would be invented); it is in Workers Observability
// (cpuTimeMs), joined by trace id / ray. Values are only span attributes we set (cache statuses, counts) and hex ids.
import type * as Tracer from "effect/Tracer"

const durMs = (sp: Tracer.Span) => sp.status._tag === "Ended" ? Number(sp.status.endTime - sp.status.startTime) / 1e6 : undefined
const q = (s: string) => `"${s.replace(/[^A-Za-z0-9 :,=._/-]/g, "").slice(0, 64)}"`
const entry = (name: string, desc: string | undefined, dur: number | undefined) =>
  name + (desc ? `;desc=${q(desc)}` : "") + (dur !== undefined && Number.isFinite(dur) ? `;dur=${dur.toFixed(1)}` : "")

export const serverTimingEntries = (spans: ReadonlyArray<Tracer.Span>, trace?: string, apiFresh?: string): string[] => {
  const out: string[] = []
  const first = (name: string) => spans.find(s => s.name === name)
  const str = (s: Tracer.Span | undefined, k: string) => { const v = s?.attributes.get(k); return typeof v === "string" && v ? v : undefined }
  const api = first("api.fetch")
  if (api) out.push(entry("api", str(api, "ephem.api_cache"), durMs(api)))
  if (apiFresh && /^(api-(blocks|geoid)(;desc="[^"]*")?(;dur=[0-9.]+)?(, )?)+$/.test(apiFresh)) out.push(apiFresh)   // the Api's fresh run (responses.ts)
  const blocks = spans.filter(s => s.name === "blocks.load")
  if (blocks.length) {
    const n = blocks.reduce((a, s) => a + (Number(s.attributes.get("blocks.count")) || 0), 0)
    out.push(entry("blocks", `${blocks.map(s => str(s, "ephem.blocks_cache") ?? "?").join(",")} n=${n}`, blocks.reduce((a, s) => a + (durMs(s) ?? 0), 0)))
  }
  const geoid = spans.filter(s => s.name === "geoid.load")
  if (geoid.length) out.push(entry("geoid", geoid.map(s => str(s, "ephem.geoid_cache") ?? "?").join(","), geoid.reduce((a, s) => a + (durMs(s) ?? 0), 0)))
  const feed = first("metar.feed")
  if (feed) out.push(entry("feed", str(feed, "ephem.feed_cache") ?? str(feed, "metar.tier"), durMs(feed)))
  if (trace && /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/.test(trace)) out.push(`trace;desc="${trace}"`)
  return out
}
