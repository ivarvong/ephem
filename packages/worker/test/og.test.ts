// The link preview (src/og.ts scene, src/og-render.ts routes and the Og entrypoint's pieces, src/og-head.ts head tags).
import { describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { makeHandler } from "../src/app.ts"
import { CORE_JS } from "../src/home.ts"
import { REC, direct, makeBlocks } from "../src/blocks.ts"
import * as og from "../src/og.ts"
import { DIN_PREV_SHA256, DIN_SHA256, OG_DIN, OG_FONTS, fontBytes, fontPath, prevFontBytes, prevFontPath, servedFont } from "../src/og-fonts.ts"
import { DIN_ADV } from "../src/din.ts"
import { OG_CACHE, OG_FALLBACK_CACHE, fallbackPng, ogData, ogFront, renderGlyph } from "../src/og-render.ts"
import { makeLoopback, ogCacheKey, type Binding, type Loopback } from "../src/loopback.ts"
import { CACHE_TAG } from "../src/cache-version.ts"

const FIX = resolve(__dirname, "../../core/test/fixtures/blocks")
const fixtures = () => makeBlocks(direct(async (first, count) => {
  const out = new Uint8Array(count * REC)
  for (let i = 0; i < count; i++) out.set(readFileSync(`${FIX}/${first + i}.bin`), i * REC)
  return out.buffer
}))
const NYC_CF = { latitude: "40.71427", longitude: "-74.00597", city: "New York City", region: "New York", country: "US", timezone: "America/New_York", colo: "EWR" }
const AT = Date.parse("2026-10-31T00:10:00Z"), T = og.bucketOf(AT)
const NYC_Q: og.OgQuery = { lat: 40.71, lon: -74.01, place: "New York City", tz: "America/New_York", t: T }
/** Real place names (Cloudflare city names and their own spellings) across the Latin scripts the font must cover. */
const PLACES = ["Tromsø", "São Paulo", "Zürich", "Reykjavík", "Kraków", "Łódź", "Gdańsk", "Częstochowa", "Ząbki", "İstanbul", "Şanlıurfa",
  "Muğla", "Győr", "Pécs", "Rīga", "Liepāja", "Ķekava", "Ogre Ļaudona", "Šiauliai", "Klaipėda", "Panevėžys", "Plzeň", "Ústí nad Labem",
  "České Budějovice", "Třebíč", "Timișoara", "Constanța", "Brașov", "Đakovo", "Ħamrun", "Żabbar", "Għajnsielem", "Malmö", "Århus",
  "Ærøskøbing", "Þórshöfn", "Göteborg", "Besançon", "Málaga", "A Coruña", "Užice", "Ľubotín", "Liptovský Mikuláš", "Luleå",
  "Saint-Étienne", "Île-de-France", "Ōsaka", "Hāna", "Tōkyō", "Bălți"]
/** The face the card should pick: the OG font when it has every character, else Noto Sans. */
const face = (t: string) => [...t].every(c => og.DIN_CHARS.has(c)) ? "din" : "noto"
const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47

describe("og: the chart is the page's (ported from CORE_JS, checked against it)", () => {
  const core = new Function(CORE_JS + "; return { wrap180, wrap360, altU, chartCenter, chartGeom, chX, chY, crBezier, trackSpan, zenithArc }")() as any
  it("projection, centre, curves", () => {
    for (const a of [-90, -60, -18, -0.5, 0, 12.3, 89.9, 95]) expect(og.altU(a)).toBe(core.altU(a))
    for (const x of [-725, -180, -0.1, 0, 179.9, 180, 540]) { expect(og.wrap180(x)).toBe(core.wrap180(x)); expect(og.wrap360(x)).toBe(core.wrap360(x)) }
    for (const azs of [[10, 350], [100, 280], [5], []]) expect(og.chartCenter(40, azs)).toBe(core.chartCenter(40, azs))
    const pg = core.chartGeom(1200, 300, 0, 0), g = og.chartGeom(1200, 300, 14, 20)
    for (const k of ["kx", "ky", "top", "hy", "bot"]) expect((g as any)[k], k).toBe(pg[k])
    for (const [az, alt] of [[0, 0], [123, 45], [359, -70]]) { expect(og.chX(az!, g, 200)).toBe(core.chX(az, pg, 200)); expect(og.chY(alt!, g)).toBe(core.chY(alt, pg)) }
    const xs = [0, 30, 70, 90, 140], ys = [100, 60, 50, 80, 20]
    for (let i = 0; i < 4; i++) expect(og.crBezier(xs, ys, i)).toEqual(core.crBezier(xs, ys, i))
  })
  it("one-revolution track spans and zenith arcs, over synthetic diurnal tracks", () => {
    for (const [dec, lat] of [[-14, 40.7], [25, 40.7], [-23, 69.6], [23, 69.6], [2, 1.35]] as const) {
      const pts: og.TrackPt[] = []
      for (let i = 0; i <= 216; i++) {   // 72 h at 20 min, a body on a fixed declination
        const H = (i * 20 / 60) * 15 * Math.PI / 180, d = dec * Math.PI / 180, p = lat * Math.PI / 180
        const alt = Math.asin(Math.sin(p) * Math.sin(d) + Math.cos(p) * Math.cos(d) * Math.cos(H))
        const az = Math.atan2(-Math.sin(H) * Math.cos(d), Math.cos(p) * Math.sin(d) - Math.sin(p) * Math.cos(d) * Math.cos(H))
        pts.push({ t: i * 1200e3, az: og.wrap360(az * 180 / Math.PI), alt: alt * 180 / Math.PI })
      }
      const sp = og.trackSpan(pts, 108, 180, 864e5)
      expect(sp).toEqual(core.trackSpan(pts, 108, 180, 864e5))
      const g = og.chartGeom(1200, 300, 18, 34), xs = sp.map(q => 600 + q.rel * g.kx), ys = sp.map(q => og.chY(q.alt, g)), xs2 = [...xs], ys2 = [...ys]
      expect(og.zenithArc(sp, xs, ys, g, 108 * 1200e3)).toEqual(core.zenithArc(sp, xs2, ys2, { ...g, x0: 4, x1: 1196 }, 108 * 1200e3))
      expect(xs).toEqual(xs2); expect(ys).toEqual(ys2)
    }
  })
})

describe("og: text in Ephem DIN, the font served for glyph", () => {
  const PAGE = new Set(Object.keys(DIN_ADV.r))   // the page's font (src/din.ts); the card uses it once OG_DIN is "current"
  it("the font covers real place names, capitals and the page's signs (every character, as displayed)", () => {
    expect(Object.keys(DIN_ADV.b)).toEqual([...PAGE])
    for (const name of PLACES) for (const c of og.din(name)) expect(PAGE.has(c), `${name}: ${c} U+${c.codePointAt(0)!.toString(16)}`).toBe(true)
    for (const c of "0123456789°·−→←↑↓–’T:") expect(PAGE.has(c), c).toBe(true)
    for (let cp = 0xc0; cp < 0x17f; cp++) { const c = String.fromCodePoint(cp); if (c !== c.toUpperCase() || c.toLowerCase() === c || cp === 0xd7 || cp === 0x14a) continue; expect(PAGE.has(c), c).toBe(true) }
  })
  it("never alters a name's characters: NFC caps only, no folding or dropping; a face that has them all sets it", () => {
    for (const name of PLACES) { expect(og.din(name)).toBe(name.normalize("NFC").toUpperCase()); expect(og.faceFor(og.din(name))).toBe(face(og.din(name))) }
    expect(og.din("Tromsø")).toBe("TROMSØ"); expect(og.din("Zu\u0308rich")).toBe("ZÜRICH")   // NFD in, the same letters out
    expect(og.din("São  Paulo\t")).toBe("SÃO PAULO")
    expect(og.faceFor(og.din("Москва"))).toBe("noto"); expect(og.din("Hà Nội")).toBe("HÀ NỘI"); expect(og.faceFor("HÀ NỘI")).toBe("noto")
    expect(og.faceFor("東京")).toBeNull()
  })
  it("the font paths are content-addressed by the sha256 of the bytes we serve", () => {
    for (const w of ["regular", "bold"] as const) {
      expect(createHash("sha256").update(fontBytes(w)).digest("hex")).toBe(DIN_SHA256[w])
      expect(createHash("sha256").update(prevFontBytes(w)).digest("hex")).toBe(DIN_PREV_SHA256[w])
      expect(fontPath(w)).toBe(`/assets/${DIN_SHA256[w].slice(0, 16)}/ephem-din-${w}.woff2`)
      expect(servedFont(fontPath(w))).toEqual(fontBytes(w)); expect(servedFont(prevFontPath(w))).toEqual(prevFontBytes(w))
      const sha = (OG_DIN === "prev" ? DIN_PREV_SHA256 : DIN_SHA256)[w]
      expect(OG_FONTS[w]).toEqual({ url: `https://ephem.ivar.workers.dev/assets/${sha.slice(0, 16)}/ephem-din-${w}.woff2`, sha256: sha })
    }
  })
})

describe("og: the image request (privacy: 0.01°, a 10-minute bucket)", () => {
  it("rounds, validates the zone, clamps the bucket, falls back to the requester's place", () => {
    const now = AT
    const q = og.parseOgQuery(new URL(`https://e/og.png?lat=40.712776&lon=-74.005974&place=New%20York%20City&tz=America/New_York&t=${T}`), now)!
    expect(q).toEqual(NYC_Q)
    expect(og.ogQueryString(q)).toBe(`lat=40.71&lon=-74.01&place=New+York+City&tz=America%2FNew_York&t=${T}`)
    expect(og.parseOgQuery(new URL(`https://e/og.png?lat=1&lon=2&tz=Mars/Olympus&t=12`), now)).toMatchObject({ tz: "UTC", t: T, place: "1.00° N, 2.00° E" })
    expect(og.parseOgQuery(new URL(`https://e/og.png?lat=1&lon=2&t=${T + 5}`), now)!.t).toBe(T)   // the future: now's bucket
    expect(og.parseOgQuery(new URL(`https://e/og.png?lat=1&lon=2&t=${T - 100}`), now)!.t).toBe(T - 100)   // within two days: kept
    expect(og.parseOgQuery(new URL("https://e/og.png"), now)).toBeNull()
    expect(og.parseOgQuery(new URL("https://e/og.png?place=%3Cb%3E"), now, { lat: 40.71427, lon: -74.00597, place: "New York City", tz: "America/New_York" }))
      .toEqual(NYC_Q)   // no lat/lon: the place is the requester's too
  })
  it("head tags: absolute og:image with the rounded place and the bucket, sizes, alt, twitter card, touch icon; escaped", () => {
    const v = { lat: 40.71427, lon: -74.00597, city: "New \"York\" <City>", place: "x", tz: "America/New_York", source: "cloudflare" }
    const h = og.ogHead({ origin: "https://ephem.example", v, now: AT })
    expect(h).toContain(`<meta property="og:image" content="https://ephem.example/og.png?lat=40.71&amp;lon=-74.01&amp;place=New+York+City&amp;tz=America%2FNew_York&amp;t=${T}">`)
    for (const t of ['property="og:image:width" content="2400"', 'property="og:image:height" content="1260"', 'property="og:image:type" content="image/png"', 'name="twitter:card" content="summary_large_image"',
      'property="og:url" content="https://ephem.example/"', '<link rel="apple-touch-icon" href="/apple-touch-icon.png">', 'property="og:title" content="ephem · the sky over New &quot;York&quot; &lt;City&gt;"'])
      expect(h).toContain(t)
    expect(h).not.toContain("40.71427")
    const q = og.ogHead({ origin: "https://ephem.example", v: { ...v, city: "Tromsø", source: "query", lat: 69.6492, lon: 18.9553, tz: "Europe/Oslo" }, now: AT })
    expect(q).toContain('property="og:url" content="https://ephem.example/?lat=69.6492&amp;lon=18.9553&amp;tz=Europe%2FOslo&amp;place=Troms%C3%B8"')   // the Copy-link URL
  })
})

describe("og: the scene from the API's own answers (fixture DE440 blocks)", () => {
  const handler = makeHandler(fixtures())
  const api: Loopback["api"] = pq => handler(new Request(`https://ephem.example${pq}`))
  it("NYC, 2026-10-31 00:10Z: data, words, and a scene glyph accepts (every text in the font, labels clear)", async () => {
    const d = await ogData(NYC_Q, api, {})
    expect(d.at).toBe(AT); expect(d.track!.count).toBe(217); expect(d.events.length).toBeGreaterThan(10)
    expect(og.ogDescription(d)).toMatch(/^Moon −?\d+\.\d° [NESW]{1,3} · .+ \d\d:\d\d · Sun −\d+° · (Night|.*twilight)$/)
    const nx = og.nextEvent(d.events, d.at)!
    expect(Date.parse(nx.time)).toBeGreaterThan(AT)
    const m = og.ogScene(d, OG_FONTS)
    expect(m.spec.size).toEqual([1200, 630])
    expect(m.spec.fonts).toEqual({ r: OG_FONTS.regular, b: OG_FONTS.bold })
    const texts = m.spec.items.filter(i => "text" in i).map(i => i.text as string)
    for (const t of texts) for (const c of t) expect(og.DIN_CHARS.has(c), `${t}: ${c}`).toBe(true)
    expect(texts).toContain("EPHEM"); expect(texts).toContain("NEW YORK CITY")
    expect(texts.some(t => /^T[−–]\d\d:\d\d:\d\d$/.test(t))).toBe(true)
    expect(m.spec.items.filter(i => "path" in i && "stroke" in i).length).toBe(4)   // two tracks, past and future
    expect(m.labels.map(l => l.id).toSorted()).toEqual(["MOON", "SUN"])
    for (const l of m.labels) {
      for (const ds of m.discs) expect(Math.hypot(Math.max(l.x - ds.x, 0, ds.x - l.x - l.w), Math.max(l.y - ds.y, 0, ds.y - l.y - l.h)), l.id).toBeGreaterThan(ds.r)
      expect(m.segs.filter(s => og.segHitsRect(s, l)).length, l.id).toBe(0)
    }
    expect(JSON.stringify(m.spec).length).toBeLessThan(60_000)   // POSTed to glyph per miss
  })
  it("the place on the card is the name's own letters: DIN when it covers them, else Noto Sans whole, else coordinates", async () => {
    const d = await ogData(NYC_Q, api, {})
    const place = (name: string) => { const m = og.ogScene({ ...d, place: name }, OG_FONTS); const it = m.spec.items.find(i => i.size === 26 && i.text !== "EPHEM")!; return { text: it.text, font: it.font, fonts: Object.keys(m.spec.fonts) } }
    for (const name of PLACES) { const t = name.normalize("NFC").toUpperCase(), din = face(t) === "din"; expect(place(name), name).toEqual({ text: t, font: din ? "r" : "nr", fonts: din ? ["r", "b"] : ["r", "b", "nr", "nb"] }) }
    if (OG_DIN === "current") expect(place("Tromsø")).toMatchObject({ text: "TROMSØ", font: "r" })
    expect(place("Москва")).toEqual({ text: "МОСКВА", font: "nr", fonts: ["r", "b", "nr", "nb"] })
    expect(place("Hà Nội")).toMatchObject({ text: "HÀ NỘI", font: "nr" })
    expect(place("東京")).toMatchObject({ text: "40.71° N, 74.01° W", font: "r" })   // no face has it: the place as coordinates, never a mangled name
  })
  it("icon and fallback specs use only the font's characters", () => {
    for (const s of [og.iconSpec(), og.fallbackSpec(OG_FONTS)]) for (const i of s.items) if ("text" in i) for (const c of i.text as string) expect(og.DIN_CHARS.has(c)).toBe(true)
  })
})

describe("og: routes and the render budget", () => {
  const seen: Array<{ url: string; key?: string | undefined }> = []
  const bind = (res: () => Response): Binding => ({ fetch: async (req, init) => { const u = new URL(req.url); seen.push({ url: u.pathname + u.search, key: init?.cf?.cacheKey }); return res() } })
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  it("/og.png: normalised, keyed /v<N>/og/png?…, the entrypoint's PNG and Cache-Control passed on", async () => {
    seen.length = 0
    const lb = makeLoopback(() => ({ Og: bind(() => new Response(png, { headers: { "content-type": "image/png", "cache-control": OG_CACHE, "x-ephem-og": "glyph", "cf-cache-status": "HIT" } })) }))
    const r = (await ogFront(new Request(`https://e/og.png?lat=40.712776&lon=-74.005974&place=New%20York%20City&tz=America/New_York&t=${T}`), lb, undefined, AT))!
    expect(r.status).toBe(200); expect(r.headers.get("content-type")).toBe("image/png"); expect(r.headers.get("cache-control")).toBe(OG_CACHE)
    expect(r.headers.get("x-ephem-og")).toBe("glyph"); expect(r.headers.get("x-ephem-og-cache")).toBe("HIT")
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(png)
    expect(seen[0]).toEqual({ url: `/png?${og.ogQueryString(NYC_Q)}`, key: `/${CACHE_TAG}/og/png?${og.ogQueryString(NYC_Q)}` })
    expect(ogCacheKey("/png?x")).toBe(`/${CACHE_TAG}/og/png?x`)
    // no lat/lon: the requester's request.cf place, rounded
    const req = new Request(`https://e/og.png?t=${T}`); Object.defineProperty(req, "cf", { value: NYC_CF })
    await ogFront(req, lb, undefined, AT)
    expect(seen[1]!.url).toBe(`/png?${og.ogQueryString(NYC_Q)}`)
  })
  it("/og.png: an error or a non-PNG answer is the fallback card, briefly cached", async () => {
    const vErr = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      for (const lb of [makeLoopback(() => ({ Og: bind(() => { throw new Error("down") }) })), makeLoopback(() => ({ Og: bind(() => new Response("x", { status: 500 })) }))]) {
        const r = (await ogFront(new Request(`https://e/og.png?lat=1&lon=2&t=${T}`), lb, undefined, AT))!
        expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toBe(OG_FALLBACK_CACHE); expect(r.headers.get("x-ephem-og")).toMatch(/^fallback:/)
        const b = new Uint8Array(await r.arrayBuffer()); expect(isPng(b)).toBe(true); expect(b).toEqual(fallbackPng())
      }
    } finally { vErr.mockRestore() }
  })
  it("the font and the touch icon; anything else is not ours", async () => {
    const lb = makeLoopback(() => ({}))
    const f = (await ogFront(new Request(`https://e${fontPath("bold")}`), lb))!
    expect(f.headers.get("content-type")).toBe("font/woff2"); expect(f.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(new Uint8Array(await f.arrayBuffer())).toEqual(fontBytes("bold"))
    for (const p of ["/apple-touch-icon.png", "/apple-touch-icon-precomposed.png"]) {
      const r = (await ogFront(new Request(`https://e${p}`), lb))!
      const b = new Uint8Array(await r.arrayBuffer())
      expect(r.headers.get("content-type")).toBe("image/png"); expect(isPng(b)).toBe(true)
      expect(new DataView(b.buffer).getUint32(16)).toBe(180); expect(new DataView(b.buffer).getUint32(20)).toBe(180)
    }
    for (const p of ["/", "/og.pngx", "/assets/0000000000000000/ephem-din-bold.woff2", "/v1/position"]) expect(await ogFront(new Request(`https://e${p}`), lb), p).toBeUndefined()
    expect(await ogFront(new Request("https://e/og.png", { method: "POST" }), lb)).toBeUndefined()
  })
  it("renderGlyph: the PNG within the budget; past it, null now and the render left running in waitUntil", async () => {
    const ok = await renderGlyph({ fetch: async () => new Response(png, { headers: { "x-glyph-cache": "origin" } }) }, {}, () => {})
    expect(ok.png).toEqual(png); expect(ok.cache).toBe("origin")
    const deferred: Array<Promise<unknown>> = []
    const slow = await renderGlyph({ fetch: () => new Promise(r => setTimeout(() => r(new Response(png)), 80)) }, {}, p => deferred.push(p), 10)
    expect(slow.png).toBeNull(); expect(slow.why).toBe("timeout"); expect(deferred.length).toBe(1)
    const bad = await renderGlyph({ fetch: async () => new Response('{"error":"font"}', { status: 502 }) }, {}, () => {})
    expect(bad.png).toBeNull(); expect(bad.why).toMatch(/^glyph 502/)
  })
})

describe("og: the page head", () => {
  const handler = makeHandler(fixtures())
  const page = async (ua: string) => { const req = new Request("https://ephem.example/", { headers: { "user-agent": ua } }); Object.defineProperty(req, "cf", { value: NYC_CF }); return (await handler(req)).text() }
  it("a person's page carries the tags with no extra work; a preview fetcher's carries the live numbers", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(AT))
    try {
      const person = await page("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1")
      expect(person).toContain(`<meta property="og:image" content="https://ephem.example/og.png?lat=40.71&amp;lon=-74.01&amp;place=New+York+City&amp;tz=America%2FNew_York&amp;t=${T}">`)
      expect(person).toContain("Where the Sun and the Moon are over New York City right now")
      const bot = await page("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0")
      expect(bot).toMatch(/<meta property="og:description" content="Moon −?\d+\.\d° [NESW]{1,3} · [^"]+ \d\d:\d\d · Sun −\d+° · [^"]+\. Live from JPL DE440\.">/)
      expect(bot.indexOf("og:image")).toBeLessThan(bot.indexOf("</head>"))
    } finally { vi.useRealTimers() }
  })
})
