import { defineWranglerConfig } from "wrangler/experimental-config";

// __EPHEM_BUILD__: a per-build id, reported in request rows (src/requestlog.ts). Caching keys on the Worker version instead.
export default defineWranglerConfig({
	minify: true,
	// No esbuild __name wrappers: they Object.defineProperty every closure the solvers create (21% of prod CPU, pprof 2026-10-29).
	keepNames: false,
	define: { __EPHEM_BUILD__: JSON.stringify(`${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`) },
});
