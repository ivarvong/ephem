// The link preview's routes (scene: src/og.ts). All answered by the front door before the app (like /favicon.ico: no router,
// no request row), each with one native span of its own:
//   GET /og.png?lat&lon&place&tz&t     the live sky card. Normalised (0.01°, the 10-minute bucket t, a valid zone; no lat/lon:
//                                      the requester's request.cf location, rounded) and fetched from the cache-enabled `Og`
//                                      entrypoint over src/loopback.ts, keyed /og/v<N>/png?<normalised query>.
//   GET /apple-touch-icon.png (and -precomposed)          the 180×180 icon iMessage and iOS show (src/og-png.generated.ts).
// Og (cache ON): reads the bucket's /v1 answers from the Api (loopback; all deterministic, so cached and shared with the
// page), builds the scene and POSTs it to glyph (service binding GLYPH → the `glyph` Worker, /render?dpr=2: 2400×1260).
// A render is `public, max-age=600`; when glyph fails or takes longer than GLYPH_BUDGET_MS the static fallback card answers
// (max-age=60, x-ephem-og: fallback) and the render runs on in waitUntil, so glyph's own cache has it for the next request.
import type { Loopback } from "./loopback.ts"
import { OG_DPR, ogApiQueries, parseOgQuery, ogQueryString, BUCKET_MS, type OgData, type OgQuery } from "./og.ts"
import { FALLBACK_PNG_B64, ICON_PNG_B64 } from "./og-png.generated.ts"
import type { Tracing } from "./trace.ts"

export const OG_CACHE = "public, max-age=600"
export const OG_FALLBACK_CACHE = "public, max-age=60"
export const GLYPH_BUDGET_MS = 2500
const DEFAULT_PLACE = { lat: 40.6892, lon: -74.0445, place: "Liberty Island", tz: "America/New_York" }

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>
let icon: Uint8Array<ArrayBuffer> | undefined, fallback: Uint8Array<ArrayBuffer> | undefined
const iconPng = () => (icon ??= b64(ICON_PNG_B64))
export const fallbackPng = () => (fallback ??= b64(FALLBACK_PNG_B64))

interface Cf {
  readonly latitude?: string
  readonly longitude?: string
  readonly city?: string
  readonly timezone?: string
}
const span = (tracing: Tracing | undefined, name: string, attrs: Record<string, string | number | boolean>) => {
  try {
    const s = tracing?.startSpan(name)
    if (!s) return
    for (const [k, v] of Object.entries(attrs)) s.setAttribute(k, v)
    s.end()
  } catch {
    /* tracing never fails a request */
  }
}

/** The front door's preview routes, or undefined for any other request. */
export const ogFront = async (
  request: Request,
  lb: Loopback,
  tracing?: Tracing,
  now = Date.now(),
): Promise<Response | undefined> => {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined
  const url = new URL(request.url),
    p = url.pathname,
    head = request.method === "HEAD"
  if (p === "/apple-touch-icon.png" || p === "/apple-touch-icon-precomposed.png")
    return new Response(head ? null : iconPng(), {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=86400",
        "x-content-type-options": "nosniff",
      },
    })
  if (p !== "/og.png") return undefined
  const cf = (request as { cf?: Cf }).cf,
    lat = Number(cf?.latitude),
    lon = Number(cf?.longitude)
  const here =
    cf?.latitude && cf.longitude && Number.isFinite(lat) && Number.isFinite(lon)
      ? { lat, lon, place: cf.city ?? "", tz: cf.timezone ?? "UTC" }
      : DEFAULT_PLACE
  const q = parseOgQuery(url, now, here)!
  const t0 = Date.now()
  let res: Response
  try {
    res = await lb.og(`/png?${ogQueryString(q)}`, request.headers.get("traceparent") ?? undefined)
  } catch (e) {
    console.error("og_loopback_failed", String(e))
    res = new Response(fallbackPng(), {
      headers: { "content-type": "image/png", "cache-control": OG_FALLBACK_CACHE, "x-ephem-og": "fallback:loopback" },
    })
  }
  const outcome = res.headers.get("x-ephem-og") ?? "",
    cache = res.headers.get("cf-cache-status") ?? ""
  span(tracing, "og.front", {
    "og.outcome": outcome,
    "og.cache": cache,
    "og.ms": Date.now() - t0,
    "og.status": res.status,
    "og.bytes": Number(res.headers.get("content-length") ?? 0),
    "og.t": q.t,
  })
  const ok = res.status === 200 && (res.headers.get("content-type") ?? "").startsWith("image/png")
  const body = ok ? res.body : (res.body?.cancel().catch(() => {}), fallbackPng())
  return new Response(head ? null : body, {
    headers: {
      "content-type": "image/png",
      "cache-control": ok ? (res.headers.get("cache-control") ?? OG_CACHE) : OG_FALLBACK_CACHE,
      "x-content-type-options": "nosniff",
      "x-ephem-og": ok ? outcome : "fallback:status",
      "x-ephem-og-cache": cache,
      "access-control-allow-origin": "*",
    },
  })
}

// ---------- the Og entrypoint ----------
export interface GlyphBinding {
  fetch(req: Request): Promise<Response>
}
export interface OgEnv {
  readonly GLYPH?: GlyphBinding
  readonly VERSION?: { readonly id: string }
}

/** The bucket's data from the Api: position at the bucket's start, the page's track window, today's and tomorrow's events. */
export const ogData = async (q: OgQuery, api: Loopback["api"], headers: Record<string, string>): Promise<OgData> => {
  const qs = ogApiQueries(q)
  const get = async (pq: string) => {
    const r = await api(pq, { method: "GET", headers })
    if (r.status !== 200) throw new Error(`${pq.split("?")[0]} ${r.status}`)
    return r.json() as Promise<any>
  }
  const [pos, track, today, tomorrow] = await Promise.all([
    get(qs.position),
    get(qs.track).catch(() => null),
    get(qs.today),
    get(qs.tomorrow).catch(() => ({ events: [] })),
  ])
  return {
    place: q.place,
    tz: q.tz,
    lat: q.lat,
    lon: q.lon,
    at: q.t * BUCKET_MS,
    sun: pos.sun,
    moon: pos.moon,
    track,
    events: [...today.events, ...tomorrow.events],
  }
}

/** Render a scene with glyph within the budget: the PNG, or why not (the render goes on in `defer` after a timeout). */
export const renderGlyph = async (
  glyph: GlyphBinding,
  spec: unknown,
  defer: (p: Promise<unknown>) => void,
  budgetMs = GLYPH_BUDGET_MS,
) => {
  const t0 = Date.now()
  const run = glyph
    .fetch(
      new Request(`https://glyph.ivar.workers.dev/render?dpr=${OG_DPR}`, {
        method: "POST",
        body: JSON.stringify(spec),
        headers: { "content-type": "application/json" },
      }),
    )
    .then(async (r) => ({
      status: r.status,
      cache: r.headers.get("x-glyph-cache") ?? "",
      body: r.status === 200 ? new Uint8Array(await r.arrayBuffer()) : null,
      err: r.status === 200 ? "" : (await r.text()).slice(0, 300),
    }))
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<"timeout">((res) => {
    timer = setTimeout(() => res("timeout"), budgetMs)
  })
  const r = await Promise.race([run, timeout]).catch((e) => ({
    status: 0,
    cache: "",
    body: null,
    err: String(e).slice(0, 300),
  }))
  clearTimeout(timer)
  if (r === "timeout") {
    defer(run.catch(() => {}))
    return { png: null, why: "timeout", ms: Date.now() - t0, cache: "" }
  }
  return { png: r.body, why: r.body ? "" : `glyph ${r.status} ${r.err}`, ms: Date.now() - t0, cache: r.cache }
}

let tracing: Tracing | undefined
export const setOgTracing = (t: Tracing | undefined) => {
  tracing = t
}
export const ogSpan = (name: string, attrs: Record<string, string | number | boolean>) => span(tracing, name, attrs)
