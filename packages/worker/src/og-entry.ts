// The Og entrypoint (cache ON, cloudflare.config.ts): one link-preview PNG per normalised query (src/og-render.ts).
import { WorkerEntrypoint } from "cloudflare:workers"
import { makeLoopback, resolveBindings, type Bindings } from "./loopback.ts"
import { ogScene, parseOgQuery } from "./og.ts"
import { ogFonts } from "./og-fonts.ts"
import { GLYPH_BUDGET_MS, OG_CACHE, OG_FALLBACK_CACHE, fallbackPng, ogData, ogSpan, renderGlyph, type OgEnv } from "./og-render.ts"

let loop: Bindings | undefined
const lb = makeLoopback(() => resolveBindings(loop))

export class Og extends WorkerEntrypoint<OgEnv> {
  async fetch(request: Request): Promise<Response> {
    loop = this.ctx.exports
    const url = new URL(request.url), q = parseOgQuery(url, Date.now())
    if (url.pathname !== "/png" || !q) return new Response("not found", { status: 404, headers: { "cache-control": "no-store" } })
    const t0 = Date.now(), attrs: Record<string, string | number | boolean> = { "og.t": q.t }
    const done = (png: Uint8Array<ArrayBuffer>, outcome: string, cc: string) => {
      ogSpan("og.render", { ...attrs, "og.outcome": outcome, "og.bytes": png.length, "og.ms": Date.now() - t0 })
      return new Response(png, { headers: { "content-type": "image/png", "cache-control": cc, "x-ephem-og": outcome, "content-length": String(png.length) } })
    }
    try {
      const headers: Record<string, string> = {}; const tp = request.headers.get("traceparent"); if (tp) headers["traceparent"] = tp
      const data = await ogData(q, lb.api, headers)
      attrs["og.data_ms"] = Date.now() - t0
      if (!this.env.GLYPH) return done(fallbackPng(), "fallback:no-glyph", OG_FALLBACK_CACHE)
      const spec = ogScene(data, ogFonts(this.env.VERSION?.id)).spec
      const r = await renderGlyph(this.env.GLYPH, spec, p => this.ctx.waitUntil(p))
      attrs["og.glyph_ms"] = r.ms; attrs["og.glyph_cache"] = r.cache
      if (r.png) return done(r.png, "glyph", OG_CACHE)
      if (r.why === "timeout") console.warn("og_render_slow", GLYPH_BUDGET_MS); else console.error("og_render_failed", r.why)
      return done(fallbackPng(), `fallback:${r.why.split(" ")[0]}`, OG_FALLBACK_CACHE)
    } catch (e) {
      console.error("og_data_failed", String(e))
      return done(fallbackPng(), "fallback:data", OG_FALLBACK_CACHE)
    }
  }
}
