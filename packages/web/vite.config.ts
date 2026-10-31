// The client build (and the dev server). Entries:
//   home   src/client/home.tsx   the homepage: hydrates the server-rendered shell, then runs the live sky
//   core   src/client/core.ts    @ephem/core's position, track and day for the browser (lazy: the home entry imports it after
//                                the first frame); its own entry so its exports keep their names (the parity test imports it)
//   app    src/styles/app.css    the one stylesheet (Tailwind CSS v4), fonts hashed alongside
//   scalar src/client/scalar.ts  /docs/interactive's Scalar boot
// Everything lands in dist/client/assets/<name>-<hash>.<ext> (content-hashed, immutable; served by Workers Static Assets).
// scripts/build-web.ts runs this and writes dist/assets.json, the server's manifest (src/server/assets.ts).
// Dev: `npm run dev` runs the Worker's local server (packages/worker/src/dev.ts, EPHEM_VITE=1) with this config in middleware
// mode: the real handler renders the pages, pointing at Vite's modules (HMR, the stylesheet injected) instead of the build.
import { writeFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import { defineConfig, type Plugin } from "vite"
import preact from "@preact/preset-vite"
import tailwindcss from "@tailwindcss/vite"

const ROOT = resolve(import.meta.dirname, "../..")

/** dist/client/../modules.json: every output chunk's source modules (repo-relative), for test/bundle.test.ts. */
const moduleList = (): Plugin => ({
  name: "ephem-module-list",
  apply: "build",
  writeBundle(options, bundle) {
    const out: Record<string, string[]> = {}
    for (const [file, c] of Object.entries(bundle))
      if (c.type === "chunk")
        out[file] = Object.entries(c.modules)
          .map(([id, m]) => relative(ROOT, id.replace(/\?.*$/, "").replace(/^\0/, "")) + " " + m.renderedLength)
          .toSorted()
    writeFileSync(resolve(options.dir ?? ".", "../modules.json"), JSON.stringify(out, null, 1) + "\n")
  },
})

export default defineConfig(({ command }) => ({
  root: import.meta.dirname,
  base: "/",
  publicDir: false,
  plugins: [preact({ prefreshEnabled: command === "serve" }), tailwindcss(), moduleList()],
  build: {
    outDir: process.env.EPHEM_WEB_OUT ?? "dist/client",
    emptyOutDir: true,
    manifest: true,
    target: "es2022",
    assetsInlineLimit: 0, // fonts and images are files (CSP: no data: fonts), never inlined
    modulePreload: { polyfill: false },
    cssCodeSplit: true,
    sourcemap: false,
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, "src/client/home.tsx"),
        core: resolve(import.meta.dirname, "src/client/core.ts"),
        app: resolve(import.meta.dirname, "src/styles/app.css"),
        scalar: resolve(import.meta.dirname, "src/client/scalar.ts"),
      },
      preserveEntrySignatures: "exports-only",
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  server: { fs: { allow: [ROOT] } },
}))
