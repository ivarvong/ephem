import { defineWranglerConfig } from "wrangler/experimental-config"

// __EPHEM_BUILD__: a per-build id, reported in request rows (src/requestlog.ts). Caching keys on the Worker version instead.
export default defineWranglerConfig({
  // The page UI (@ephem/web): Vite builds the client into packages/web/dist/client (content-hashed, immutable: its _headers),
  // served by Workers Static Assets ahead of the Worker; the Worker renders pages from its manifest. The build runs first
  // (a no-op when nothing changed; deploy.sh builds before the gate and the upload, so both see the same bytes).
  assetsDirectory: "../web/dist/client",
  build: { command: "node --experimental-strip-types ../../scripts/build-web.ts --if-stale", cwd: "." },
  minify: true,
  // No esbuild __name wrappers: they Object.defineProperty every closure the solvers create (21% of prod CPU, pprof 2026-10-29).
  keepNames: false,
  define: { __EPHEM_BUILD__: JSON.stringify(`${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`) },
})
