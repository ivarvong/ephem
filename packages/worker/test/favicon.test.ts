import { describe, expect, it } from "vitest"
import { ICON_HREF, ICON_SVG, renderDocs, renderHomeStatic, renderScalar } from "@ephem/web/server"
import { favicon } from "../src/favicon.ts"
import { docsContent } from "../src/docs.ts"

const V = { lat: 1, lon: 2, place: "x", city: "x", tz: "UTC", colo: null, source: "query" } as const

describe("favicon: zero requests from our pages, a tiny immutable /favicon.ico for everyone else", () => {
  it("every HTML page inlines the icon as a data URI (so the browser never asks for /favicon.ico)", async () => {
    for (const html of [
      await renderHomeStatic({ v: V, blocks: "/b/", now: 0 }),
      renderDocs(docsContent()),
      renderScalar(),
    ]) {
      expect(html).toContain(`<link rel="icon" type="image/svg+xml" href="${ICON_HREF}"/>`)
      expect(html.match(/<link rel="icon"/g)).toHaveLength(1)
    }
    expect(ICON_HREF).toMatch(/^data:image\/svg\+xml,[^"<>]+$/)
  })
  it("GET /favicon.ico is the SVG, immutable for a year; HEAD has no body; nothing else matches", async () => {
    const r = favicon(new Request("https://e.example/favicon.ico?x=1"))!
    expect(r.status).toBe(200)
    expect(r.headers.get("content-type")).toBe("image/svg+xml")
    expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(await r.text()).toBe(ICON_SVG)
    expect(ICON_SVG.length).toBeLessThan(512)
    expect(await favicon(new Request("https://e.example/favicon.ico", { method: "HEAD" }))!.text()).toBe("")
    expect(favicon(new Request("https://e.example/favicon.ico", { method: "POST" }))).toBeUndefined()
    expect(favicon(new Request("https://e.example/"))).toBeUndefined()
    expect(favicon(new Request("https://e.example/assets/favicon.ico"))).toBeUndefined()
  })
})
