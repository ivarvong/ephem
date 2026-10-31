// The client build (scripts/build-web.ts → dist/): what ships, what each chunk carries, the headers that make it immutable,
// and that the stylesheet the homepage inlines is the hashed file byte for byte (its CSP hash is of those bytes).
import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { COLOR } from "../src/lib/tokens.ts"

const DIST = resolve(__dirname, "../dist"), CLIENT = resolve(DIST, "client")
const manifest = JSON.parse(readFileSync(resolve(DIST, "assets.json"), "utf8"))
const modules = JSON.parse(readFileSync(resolve(DIST, "modules.json"), "utf8")) as Record<string, string[]>
const chunk = (url: string) => (modules[url.slice(1)] ?? []).map(m => m.replace(/ \d+$/, ""))
const file = (url: string) => readFileSync(resolve(CLIENT, url.slice(1)))

describe("the client build", () => {
  it("every public file is content-hashed and immutable for a year (Workers Static Assets _headers); the manifest is not public", () => {
    const files = readdirSync(resolve(CLIENT, "assets"))
    for (const f of files) expect(f, f).toMatch(/^[a-z0-9-]+-[A-Za-z0-9_-]{8}\.(js|css|woff2)$/)
    expect(readdirSync(CLIENT).sort()).toEqual(["_headers", "assets", "ephem-assets.json"])
    const own = JSON.parse(readFileSync(resolve(CLIENT, "ephem-assets.json"), "utf8")).files as string[]
    for (const u of [manifest.home.js, manifest.core.js, manifest.css.href, manifest.fonts.regular.href, manifest.fonts.bold.href]) expect(own).toContain(u)
    expect(readFileSync(resolve(CLIENT, "_headers"), "utf8")).toContain("/ephem-assets.json\n  Cache-Control: no-store")   // the list itself is never cached
    const h = readFileSync(resolve(CLIENT, "_headers"), "utf8")
    expect(h).toMatch(/^\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable\n/)
  })
  it("the inlined stylesheet is the hashed file, and its CSP hash is of exactly those bytes", () => {
    expect(file(manifest.css.href).toString("utf8")).toBe(manifest.css.text)
    expect(createHash("sha256").update(manifest.css.text).digest("base64")).toBe(manifest.css.sha256)
    expect(manifest.css.text).not.toMatch(/data:font|url\(data:|@font-face/)   // fonts are files, added by the page after boot
    expect(file(manifest.home.js).toString("utf8")).toContain(manifest.fonts.regular.href)   // src/client/fonts.ts
  })
  it("the fonts are the Ephem DIN files byte for byte, with the sha256 glyph pins", () => {
    for (const w of ["regular", "bold"] as const) {
      const src = readFileSync(resolve(__dirname, `../src/fonts/ephem-din-${w}.woff2`))
      expect(file(manifest.fonts[w].href).equals(src)).toBe(true)
      expect(createHash("sha256").update(src).digest("hex")).toBe(manifest.fonts[w].sha256)
    }
    expect(manifest.fonts.regular.sha256).toBe("316a72622a0926ee85e3db60007e0347aede4005a56d197a624d8910a3292d50")
  })
  it("the in-browser core carries only what position, track and day run: no geoid grid, WMM, search or alignment", () => {
    const core = chunk(manifest.core.js), names = core.map(m => m.split("/").pop())
    expect(core.every(m => m.startsWith("packages/core/src/") || m === "packages/web/src/client/core.ts")).toBe(true)
    for (const bad of ["egm96-grid.ts", "geoid-bundled.ts", "wmm.ts", "search.ts", "region.ts", "alignment.ts"]) expect(names, bad).not.toContain(bad)
    const js = file(manifest.core.js).toString("utf8")
    for (const w of ["WMM", "bandRows", "alignment", "search"]) expect(js.includes(w), w).toBe(false)
    expect(js.length).toBeLessThan(20_000)
  })
  it("the home entry does not carry the core (it loads after the first frame) and no Effect", () => {
    const home = chunk(manifest.home.js)
    expect(home.some(m => m.startsWith("packages/core/"))).toBe(false)
    expect(home.some(m => m.includes("node_modules/effect"))).toBe(false)
    expect(file(manifest.home.js).toString("utf8")).toContain(manifest.core.js.split("/").pop())   // the lazy import names the hashed core
  })
  it("the stylesheet's @theme tokens are the canvas colours (lib/tokens.ts)", () => {
    const src = readFileSync(resolve(__dirname, "../src/styles/app.css"), "utf8")
    for (const [k, v] of Object.entries(COLOR)) expect(src, k).toContain(`--color-${k}: ${v};`)
  })
})
