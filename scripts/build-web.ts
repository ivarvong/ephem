// Build the web client (packages/web, Vite) and its server manifest:
//   packages/web/dist/client/          the Worker's static assets directory (Workers Static Assets, packages/worker/wrangler.config.ts):
//                                      assets/<name>-<hash>.{js,css,woff2}, _headers (immutable for a year) and ephem-assets.json
//                                      (this build's own files, for the next deploy to carry: scripts/keep-assets.py)
//   packages/web/dist/assets.json      what the server renders with (src/server/assets.ts): entry URLs, modulepreloads, the
//                                      stylesheet's URL, text (inlined in the homepage's head) and CSP hash, the fonts' URLs
//                                      and sha256 (glyph pins the OG card's fonts by hash), the inputs hash
//   packages/web/dist/modules.json     every chunk's source modules (test/bundle.test.ts)
//   node --experimental-strip-types scripts/build-web.ts              # build
//   node --experimental-strip-types scripts/build-web.ts --if-stale   # build only if an input changed since the last build
// The build goes to a temporary directory that replaces dist in one rename, so a reader (a deploy uploading dist/client, a
// test reading assets.json) never sees half a build. Inputs: packages/web (sources, config), packages/core/src (bundled into
// the client), package-lock.json. typecheck and the tests call it with --if-stale; deploy.sh calls it before both.
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"

const ROOT = join(import.meta.dirname, "..")
const WEB = join(ROOT, "packages/web")
export const DIST = join(WEB, "dist")
export const MANIFEST = join(DIST, "assets.json")
const INPUTS = [join(WEB, "src"), join(WEB, "vite.config.ts"), join(WEB, "package.json"), join(ROOT, "packages/core/src"), join(ROOT, "package-lock.json"), import.meta.filename]

const files = (p: string): string[] => statSync(p).isDirectory() ? readdirSync(p).sort().flatMap(n => files(join(p, n))) : [p]
/** sha256 over every input file's path and bytes. */
export const inputsHash = (): string => {
  const h = createHash("sha256")
  for (const f of INPUTS.flatMap(files)) h.update(relative(ROOT, f)).update("\0").update(readFileSync(f)).update("\0")
  return h.digest("hex")
}
export const isFresh = (hash = inputsHash()): boolean => {
  try { return JSON.parse(readFileSync(MANIFEST, "utf8")).inputs === hash && existsSync(join(DIST, "client/_headers")) } catch { return false }
}

interface ViteChunk { readonly file: string; readonly name?: string; readonly src?: string; readonly isEntry?: boolean; readonly imports?: ReadonlyArray<string>; readonly dynamicImports?: ReadonlyArray<string>; readonly css?: ReadonlyArray<string> }
const sha256 = (b: Buffer | string, enc: "hex" | "base64") => createHash("sha256").update(b).digest(enc)

export const buildWeb = async (): Promise<{ readonly hash: string; readonly ms: number }> => {
  const t0 = performance.now(), hash = inputsHash()
  const tmp = join(WEB, `dist.tmp-${process.pid}`), out = join(tmp, "client")
  rmSync(tmp, { recursive: true, force: true })
  const { build } = await import("vite")
  process.env.EPHEM_WEB_OUT = out
  await build({ configFile: join(WEB, "vite.config.ts"), logLevel: "warn", mode: "production" })
  const vm = JSON.parse(readFileSync(join(out, ".vite/manifest.json"), "utf8")) as Record<string, ViteChunk>
  rmSync(join(out, ".vite"), { recursive: true })   // the manifest is the server's, not a public asset
  const bySrc = (src: string) => { const c = vm[src]; if (!c) throw new Error(`vite manifest has no ${src}`); return c }
  const url = (file: string) => "/" + file
  /** An entry's static imports, transitively (modulepreload them so they load in parallel with the entry). */
  const preloads = (key: string, seen = new Set<string>()): string[] => {
    for (const k of vm[key]?.imports ?? []) if (!seen.has(k)) { seen.add(k); preloads(k, seen) }
    return [...seen].map(k => url(vm[k]!.file))
  }
  const home = bySrc("src/client/home.tsx"), core = bySrc("src/client/core.ts"), app = bySrc("src/styles/app.css"), scalar = bySrc("src/client/scalar.ts")
  const cssFile = app.file.endsWith(".css") ? app.file : app.css?.[0]
  if (!cssFile) throw new Error("no stylesheet in the build")
  const cssText = readFileSync(join(out, cssFile), "utf8")
  const font = (name: string) => {
    const f = Object.values(vm).find(c => c.src?.endsWith(`fonts/${name}.woff2`))?.file ?? readdirSync(join(out, "assets")).map(n => "assets/" + n).find(n => n.startsWith(`assets/${name}-`) && n.endsWith(".woff2"))
    if (!f) throw new Error(`no ${name}.woff2 in the build`)
    return { href: url(f), sha256: sha256(readFileSync(join(out, f)), "hex"), bytes: statSync(join(out, f)).size }
  }
  const manifest = {
    inputs: hash,
    home: { js: url(home.file), preload: preloads("src/client/home.tsx") },
    core: { js: url(core.file), preload: preloads("src/client/core.ts") },
    scalar: { js: url(scalar.file) },
    css: { href: url(cssFile), text: cssText, sha256: sha256(cssText, "base64") },
    fonts: { regular: font("ephem-din-regular"), bold: font("ephem-din-bold") },
  }
  writeFileSync(join(tmp, "assets.json"), JSON.stringify(manifest, null, 1) + "\n")
  // Workers Static Assets: every built file is content-hashed, so immutable for a year (docs/telemetry_and_profiling.md "Homepage").
  writeFileSync(join(out, "_headers"), "/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n  X-Content-Type-Options: nosniff\n  Access-Control-Allow-Origin: *\n" +
    "/ephem-assets.json\n  Cache-Control: no-store\n")
  // this build's own public files: the next deploy carries them over (scripts/keep-assets.py), so pages served by this version
  // keep loading their lazy module and fonts after it is replaced
  writeFileSync(join(out, "ephem-assets.json"), JSON.stringify({ inputs: hash, files: readdirSync(join(out, "assets")).sort().map(f => "/assets/" + f) }) + "\n")
  const old = join(WEB, `dist.old-${process.pid}`)
  if (existsSync(DIST)) renameSync(DIST, old)
  renameSync(tmp, DIST)
  rmSync(old, { recursive: true, force: true })
  return { hash, ms: performance.now() - t0 }
}

if (import.meta.main) {
  if (process.argv.includes("--if-stale") && isFresh()) { console.log("web build: up to date"); process.exit(0) }
  const r = await buildWeb()
  const m = JSON.parse(readFileSync(MANIFEST, "utf8"))
  console.log(`web build ${r.hash.slice(0, 12)} in ${Math.round(r.ms)} ms: ${m.home.js} (+${m.home.preload.length} preloads), ${m.core.js}, ${m.css.href} (${m.css.text.length} B)`)
}
