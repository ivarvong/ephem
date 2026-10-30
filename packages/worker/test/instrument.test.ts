import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { makeHandler } from "../src/app.ts"
import { makeBlocks } from "../src/blocks.ts"
import { ASSETS } from "../src/instrument-ds.ts"
import { assetUrl, instrumentPage } from "../src/instrument.ts"

const V = { lat: 40.7128, lon: -74.006, place: "New York", city: "New York", tz: "America/New_York", colo: null, source: "query" } as const
const handler = makeHandler(makeBlocks({ read: async () => { throw new Error("no blocks needed") } } as never))

describe("/instrument", () => {
  it("serves the page, location from ?lat&lon like the homepage, never cached", async () => {
    const r = await handler(new Request("http://x/instrument?lat=69.65&lon=18.96&tz=Europe/Oslo&place=Troms%C3%B8"))
    expect(r.status).toBe(200)
    expect(r.headers.get("cache-control")).toBe("private, no-store")
    const html = await r.text()
    expect(html).toContain('"lat":69.65'); expect(html).toContain('"tz":"Europe/Oslo"')
    expect(html).toContain('href="/?lat=69.65&amp;lon=18.96')   // back to the sky view, same place
  })
  it("every inline script parses (they live in TS templates) and the place cannot break out", () => {
    const html = instrumentPage({ ...V, place: "</script><script>alert(1)</script>", city: "x" })
    expect(html).not.toContain("</script><script>alert(1)")
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]!)
    expect(scripts.length).toBe(5)   // theme, engine, view, LOC, glue
    for (const js of scripts) expect(() => new Function(js)).not.toThrow()
  })
  it("request budget: first load calls only /v1/position (live, no time) and /v1/day", () => {
    const html = instrumentPage(V)
    expect(new Set(html.match(/\/v1\/[a-z/]+/g))).toEqual(new Set(["/v1/position", "/v1/day"]))
    expect(html).not.toMatch(/\/v1\/position[^"]*time=/)
  })
  it("fonts and licences: immutable, content-addressed, byte-exact; a wrong sha is 404", async () => {
    for (const [name, a] of Object.entries(ASSETS)) {
      const r = await handler(new Request("http://x" + assetUrl(name)))
      expect(r.status, name).toBe(200)
      expect(r.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
      expect(r.headers.get("content-type")).toContain(a.type.split(";")[0]!)
      const b = new Uint8Array(await r.arrayBuffer())
      expect(createHash("sha256").update(b).digest("hex").slice(0, 12), name).toBe(a.sha)
      expect(instrumentPage(V).includes(assetUrl(name)), name).toBe(true)   // fonts preloaded + @font-face; licences linked
    }
    expect((await handler(new Request("http://x/assets/000000000000/RPNDot-Regular.woff2"))).status).toBe(404)
    expect((await handler(new Request("http://x/assets/" + ASSETS["RPNDot-Regular.woff2"]!.sha + "/nope.woff2"))).status).toBe(404)
    expect(Object.keys(ASSETS).filter(n => n.endsWith("-OFL.txt")).length).toBe(2)
  })
  it("no maker's branding; the magnetic declination is inlined (AZ M costs no request)", () => {
    const html = instrumentPage(V, "", Date.parse("2026-10-30T22:08:44Z"))
    expect(html).not.toMatch(/\bHP\b|Hewlett|Packard/)
    expect(html).toMatch(/"magdec":-12\.46\d+/)   // WMM2025 at New York; /v1/magnetic said -12.461292467665574 at this instant
    expect(html).toContain("declination −12.46°")
  })
  it("the page's fonts: exactly three, all preloaded, all immutable /assets URLs", () => {
    const html = instrumentPage(V)
    expect(html.match(/<link rel="preload"[^>]+as="font"/g)?.length).toBe(3)
    expect(new Set([...html.matchAll(/url\("([^"]+)"\)/g)].map(m => m[1]))).toEqual(new Set(Object.keys(ASSETS).filter(n => n.endsWith(".woff2")).map(assetUrl)))
  })
  it("the homepage links to it quietly", async () => {
    expect(await (await handler(new Request("http://x/"))).text()).toContain('href="/instrument"')
  })
})
