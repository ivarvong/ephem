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
  it("the stylesheet has exactly the utilities the markup uses, and defines every class the markup names", () => {
    // Tailwind's automatic source detection makes a utility of any candidate word in its sources: `"hidden"`, `overflow="visible"`,
    // `addEventListener("resize"`, a comment saying "ring" (2 KB of ring utilities, 2026-10-31). app.css turns it off
    // (source(none)) and lists the utilities the markup uses (@source inline); this test keeps that list exact.
    const css = manifest.css.text as string, at = css.indexOf("@layer utilities{")
    expect(at).toBeGreaterThan(0)
    let depth = 0, end = at
    for (let i = css.indexOf("{", at); i < css.length; i++) { if (css[i] === "{") depth++; else if (css[i] === "}" && --depth === 0) { end = i; break } }
    const classesIn = (text: string) => {
      const out = new Set<string>()
      for (const m of text.matchAll(/([^{};]+)\{/g)) {
        if (m[1]!.trim().startsWith("@")) continue
        for (const c of m[1]!.matchAll(/\.((?:\\.|[A-Za-z_-])(?:\\.|[A-Za-z0-9_-])*)/g)) out.add(c[1]!.replace(/\\(.)/g, "$1"))
      }
      return out
    }
    const utilities = classesIn(css.slice(at + 17, end)), defined = classesIn(css)
    // the markup's class names: every string literal in a class attribute (static, or inside class={...}) under src/
    const used = new Set<string>(), walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = resolve(d, e.name)
        if (e.isDirectory()) walk(p)
        else if (e.name.endsWith(".tsx")) for (const m of readFileSync(p, "utf8").matchAll(/\bclass=(?:"([^"]*)"|\{([^}]*)\})/g)) {
          const lits = m[1] != null ? [m[1]] : [...m[2]!.matchAll(/(===|!==)?\s*"([^"]*)"/g)].filter(x => !x[1]).map(x => x[2]!)   // not a compared value
          for (const l of lits) for (const t of l.split(/\s+/)) if (t) used.add(t)
        }
      }
    }
    walk(resolve(__dirname, "../src"))
    expect(used.size).toBeGreaterThan(30)
    for (const u of utilities) expect(used.has(u), `utility .${u} is in no class attribute under src/`).toBe(true)
    for (const c of used) expect(defined.has(c), `class "${c}" is used in the markup and defined nowhere in the stylesheet`).toBe(true)
    expect(css).not.toContain("--tw-ring")
  })
  it("the stylesheet's @theme tokens are the canvas colours (lib/tokens.ts)", () => {
    const src = readFileSync(resolve(__dirname, "../src/styles/app.css"), "utf8")
    for (const [k, v] of Object.entries(COLOR)) expect(src, k).toContain(`--color-${k}: ${v};`)
  })
})
