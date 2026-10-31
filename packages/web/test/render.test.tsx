// Server rendering: the homepage document (head + header, then the first frame), /docs and /docs/interactive. No page carries an inline
// executable script or an inline event handler; every script is a same-origin module or the pinned Scalar file.
import { describe, expect, it } from "vitest"
import { assets, renderDocs, renderHomeBody, renderHomeHead, renderHomeStatic, renderScalar, homeCsp, SCALAR } from "../src/server/index.ts"
import type { Visitor } from "../src/lib/types.ts"

const V: Visitor = { lat: 40.7, lon: -74, place: "New York City, New York, US", city: "New York City", tz: "America/New_York", colo: "EWR", source: "cloudflare" }
const TP = `00-${"4bf92f3577b34da6a3ce929d0e0e4736"}-${"00f067aa0ba902b7"}-01`
const head = { v: V, traceparent: TP, blocks: "/assets/de440/0123456789abcdef/", now: 1793400000000 }

/** Every <script> and every on* attribute in a document. */
export const scriptsOf = (html: string) => [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map(m => ({ attrs: m[1]!, body: m[2]! }))
export const handlersOf = (html: string) => [...html.matchAll(/<[a-z][^>]*\son[a-z]+\s*=/gi)].map(m => m[0])
const executable = (s: { attrs: string; body: string }) => !/type="application\/json"/.test(s.attrs)

describe("the homepage document", () => {
  it("head first (stylesheet inline, the module, the boot JSON), then the shell, then the answers; no inline executable script", async () => {
    const html = await renderHomeStatic(head)
    expect(html.startsWith('<!doctype html><html lang="en" class="home"><head><meta charset="utf-8"/>')).toBe(true)
    expect(html.endsWith("</body></html>")).toBe(true)
    expect(html).toContain(`<meta name="traceparent" content="${TP}"/>`)
    expect(html).toContain(`<style>${assets().css.text}</style>`)
    expect(html).toContain(`<script type="module" src="${assets().home.js}"></script>`)
    const ss = scriptsOf(html)
    for (const s of ss.filter(executable)) { expect(s.body, s.attrs).toBe(""); expect(s.attrs).toMatch(/ src="\/assets\/[^"]+\.js"/) }
    expect(handlersOf(html)).toEqual([])
    expect(html.indexOf('id="ephem-boot"')).toBeLessThan(html.indexOf("<body>"))
    for (const id of ["top", "place", "clock", "live", "liveT", "sky", "cv", "ctl", "golive", "recenter", "point", "tminus", "next", "phase", "guide", "tlbox", "tl", "bodies", "details", "evmore", "dayTitle", "wx", "locate", "share", "hood", "curl", "diag", "foot"])
      expect(html, id).toContain(`id="${id}"`)
    expect(html).toMatch(/<details class="disc hood" id="hood"><summary>Under the hood<\/summary>/)
  })
  it("the boot JSON carries the visitor safely: no script breakout from a place name", async () => {
    const evil = "</script><script>alert(1)</script>"
    const html = await renderHomeStatic({ ...head, v: { ...V, place: evil, city: evil } })
    expect(html).not.toContain("</script><script>alert(1)")
    expect(html).toContain("\\u003c/script>")
    const boot = JSON.parse(/<script type="application\/json" id="ephem-boot">(.*?)<\/script>/.exec(html)![1]!)
    expect(boot.loc.city).toBe(evil)
    expect(boot.sky).toEqual({ core: assets().core.js, coreId: expect.stringMatching(/^[A-Za-z0-9_-]{8}$/), blocks: head.blocks, now: head.now })
    expect(boot.at).toBe(head.now); expect(boot.frame).toEqual({ W: 1440, H: 504, strip: 1080, mobile: false })   // no phone in the request: the desktop frame
  })
  it("never alters a place name's characters (the page shows it via text; caps come from CSS)", async () => {
    for (const name of ["Tromsø", "São Paulo", "Zürich", "Reykjavík", "Łódź", "İstanbul", "Москва"]) {
      const html = await renderHomeStatic({ ...head, v: { ...V, city: name, place: name } })
      expect(html).toContain(`<title>ephem · the sky over ${name}</title>`)
      expect(html).toContain(JSON.stringify(name).slice(1, -1))
    }
  })
  it("the head carries the header (its own root); the body brings the frame and the answers, escaped, and ends the document", () => {
    const h = renderHomeHead(head)
    expect(h).toContain('</head><body><div id="hdr"><header class="hd gut" id="top">')
    expect(h).not.toContain('id="app"')
    const b = renderHomeBody(head, [["ephem-x", '{"a":"</script>"}']])
    expect(b.startsWith('<div id="app">')).toBe(true)
    expect(b.endsWith('<script type="application/json" id="ephem-x">{"a":"\\u003c/script>"}</script></body></html>')).toBe(true)
  })
  it("a synthetic request says so to its RUM; a real one does not", async () => {
    expect(await renderHomeStatic({ ...head, synthetic: true })).toContain('<meta name="ephem-synthetic" content="1"/>')
    expect(await renderHomeStatic(head)).not.toContain("ephem-synthetic")
  })
  it("CSP: scripts from this origin only, no inline script, the one inline style by hash", () => {
    const csp = homeCsp()
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|nonce-/)
    expect(csp).toContain(`style-src 'self' 'sha256-${assets().css.sha256}'`)
    expect(csp).toContain("default-src 'none'")
  })
})

describe("docs pages", () => {
  const c = { base: "https://e", quickstart: [{ question: "Q?", path: "/v1/x" }], rules: ["r <b>"], endpoints: [{ path: "/v1/x", question: "X?", summary: "s", params: "lat*", example: "/v1/x?a=1&b=2" }], params: [["lat", "deg"] as const], conventions: [["frame", "ICRS"] as const] }
  it("/docs is plain HTML: no script at all, our stylesheet, text escaped", () => {
    const html = renderDocs(c)
    expect(scriptsOf(html)).toEqual([]); expect(handlersOf(html)).toEqual([])
    expect(html).toContain(`<link rel="stylesheet" href="${assets().css.href}"/>`)
    expect(html).toContain("<li>r &lt;b></li>"); expect(html).toContain('href="/v1/x?a=1&amp;b=2"')
  })
  it("/docs/interactive: the pinned Scalar file with its integrity, then our boot module; nothing inline", () => {
    const html = renderScalar(), ss = scriptsOf(html)
    expect(ss.map(s => s.body)).toEqual(["", ""]); expect(handlersOf(html)).toEqual([])
    expect(ss[0]!.attrs).toContain(`src="${SCALAR.src}" integrity="${SCALAR.integrity}" crossorigin="anonymous"`)
    expect(ss[1]!.attrs).toBe(` type="module" src="${assets().scalar.js}"`)
  })
})
