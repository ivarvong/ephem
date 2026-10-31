import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { DE440 } from "@ephem/core"
import { makeHandler } from "../src/app.ts"
import { REC, R2_KEY, direct, makeBlocks, r2Origin, type R2BucketLike } from "../src/blocks.ts"
import { ASSETS, SOFIA_RANGES } from "../src/instrument-ds.ts"
import { EMBED_ID, assetUrl, instrumentPage } from "../src/instrument.ts"

const V = { lat: 40.7128, lon: -74.006, place: "New York", city: "New York", tz: "America/New_York", colo: null, source: "query" } as const
const handler = makeHandler(makeBlocks({ read: async () => { throw new Error("no blocks needed") } } as never))
// Real DE440 blocks for 2026-10-28 (the core's fixtures), as test/mcp.test.ts.
const FIX = resolve(__dirname, "../../core/test/fixtures")
const fixtureBlock = (i: number) => { const b = readFileSync(`${FIX}/blocks/${i}.bin`); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer }
const bucket: R2BucketLike = {
  async get(key, opts) {
    if (key !== R2_KEY || !opts?.range) return null
    const { offset, length } = opts.range, out = new Uint8Array(length)
    for (let o = 0; o < length; o += REC) out.set(new Uint8Array(fixtureBlock((offset + o) / REC - 2)), o)
    return { size: DE440.sizeBytes, arrayBuffer: async () => out.buffer }
  },
  async head() { return { size: DE440.sizeBytes, customMetadata: { sha256: DE440.sha256 } } },
  async put() { throw new Error("read-only") },
}
const live = makeHandler(makeBlocks(direct(r2Origin(bucket))))
const embedOf = (html: string) => {
  const m = new RegExp(`<script type="application/json" id="${EMBED_ID}">([\\s\\S]*?)</script>`).exec(html)
  return m ? JSON.parse(m[1]!) : null
}
const noDiag = (b: any) => { const { provenance: { diagnostics: _, ...prov }, ...rest } = b; return { ...rest, provenance: prov } }
afterEach(() => { vi.useRealTimers() })

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
    expect(scripts.length).toBe(4)   // head (theme, LOC, trace, RUM, boot), engine, view, glue
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
    }
    expect((await handler(new Request("http://x/assets/000000000000/RPNDot-Regular.woff2"))).status).toBe(404)
    expect((await handler(new Request("http://x/assets/" + ASSETS["RPNDot-Regular.woff2"]!.sha + "/nope.woff2"))).status).toBe(404)
    expect(Object.keys(ASSETS).filter(n => n.endsWith("-OFL.txt")).length).toBe(2)
    for (const n of ["RPNDot-OFL.txt", "SofiaSansCondensed-OFL.txt"]) expect(instrumentPage(V).includes(assetUrl(n)), n).toBe(true)   // licences linked
  })
  it("no maker's branding; the magnetic declination is inlined (AZ M costs no request)", () => {
    const html = instrumentPage(V, "", Date.parse("2026-10-30T22:08:44Z"))
    expect(html).not.toMatch(/\bHP\b|Hewlett|Packard/)
    expect(html).toMatch(/"magdec":-12\.46\d+/)   // WMM2025 at New York; /v1/magnetic said -12.461292467665574 at this instant
    expect(html).toContain("declination −12.46°")
  })
  it("fonts cost no request: the dot faces and Sofia's core inline; Sofia's full file only outside the core's range", () => {
    const html = instrumentPage(V)
    expect(html).not.toMatch(/<link rel="preload"/)
    for (const n of ["RPNDot-Regular.woff2", "RPNDotSmall-Regular.woff2", "SofiaSansCondensed-Core.woff2"]) expect(html, n).toContain(`url("data:font/woff2;base64,${ASSETS[n]!.b64}")`)
    expect(new Set([...html.matchAll(/url\("(\/[^"]+)"\)/g)].map(m => m[1]))).toEqual(new Set([assetUrl("SofiaSansCondensed-Legend.woff2")]))
    expect(html).toContain(`unicode-range:${SOFIA_RANGES.rest}}`); expect(html).toContain(`unicode-range:${SOFIA_RANGES.core}}`)
    // the two ranges split the full file's code points; every character the page's own text uses is in the core
    const cps = (r: string) => r.split(",").flatMap(x => { const [a, b] = x.slice(2).split("-").map(h => parseInt(h, 16)); return Array.from({ length: (b ?? a!) - a! + 1 }, (_, i) => a! + i) })
    const core = new Set(cps(SOFIA_RANGES.core)), rest = new Set(cps(SOFIA_RANGES.rest))
    expect([...core].filter(c => rest.has(c))).toEqual([])
    const text = instrumentPage(V).split("<body>")[1]!.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/g, " ")
    expect([...new Set(text)].filter(ch => ch.codePointAt(0)! >= 0x20 && !core.has(ch.codePointAt(0)!) && !"⌘⌫".includes(ch))).toEqual([])   // ⌘ ⌫: in neither (system font, as before)
  })
  it("first data is embedded: the API's own answers (live position, today's day), so the page draws with zero fetches", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-28T11:51:00Z"), toFake: ["Date"] })
    const q = "lat=40.7127&lon=-74.0059&tz=America/New_York"
    const html = await (await live(new Request(`http://x/instrument?${q}`))).text()
    const e = embedOf(html)
    expect(e.date).toBe("2026-10-28")
    const pos = await (await live(new Request("http://x/v1/position?lat=40.71270&lon=-74.00590"))).json()
    const day = await (await live(new Request("http://x/v1/day?lat=40.71270&lon=-74.00590&date=2026-10-28&tz=America%2FNew_York"))).json()
    expect(noDiag(e.position)).toEqual(noDiag(pos)); expect(e.position.time.utc).toBe("2026-10-28T11:51:00.000Z")
    expect(noDiag(e.day)).toEqual(noDiag(day)); expect(e.day.events.length).toBeGreaterThan(3)
  })
  it("the embed never breaks the page: no data (here: no blocks) means no embed, and the page fetches as before", async () => {
    const r = await handler(new Request("http://x/instrument?lat=40.7&lon=-74&tz=America/New_York"))
    expect(r.status).toBe(200)
    const html = await r.text(), e = embedOf(html)
    expect(e === null || (e.position === null && e.day === null)).toBe(true)
    expect(html).toContain('id="calc"'); expect(html).toContain("RPNEngine")
    expect(instrumentPage(V)).not.toContain(EMBED_ID + '">')   // no init: no embed script; GLUE fetches
  })
  it("streams: the head (CSS, fonts, boot, engine) is the first chunk, before any data", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-10-28T11:51:00Z"), toFake: ["Date"] })
    const r = await live(new Request("http://x/instrument?lat=40.7127&lon=-74.0059&tz=America/New_York"))
    expect(r.headers.get("cache-control")).toBe("private, no-store")
    const reader = r.body!.getReader(), first = new TextDecoder().decode((await reader.read()).value)
    expect(first.endsWith("</head>")).toBe(true); expect(first).not.toContain(EMBED_ID)
    expect(first).toContain("RPNEngine"); expect(first).toContain("--font-legend"); expect(first).not.toContain('id="calc"')
    let rest = ""; for (;;) { const c = await reader.read(); if (c.done) break; rest += new TextDecoder().decode(c.value) }
    expect(rest).toContain(EMBED_ID); expect(rest.trimEnd().endsWith("</body></html>")).toBe(true)
  })
  it("the homepage links to it quietly", async () => {
    expect(await (await handler(new Request("http://x/"))).text()).toContain('href="/instrument"')
  })
})
