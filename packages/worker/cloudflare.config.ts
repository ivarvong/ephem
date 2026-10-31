import { bindings, defineConfig, exports } from "cf/config";

export default defineConfig({
	worker: {
		name: "ephem",
		compatibilityDate: "2026-10-01",
		entrypoint: "src/index.ts",
		observability: {
			enabled: true,
			traces: { enabled: true, headSamplingRate: 1 },
		},
		// Workers Caching (never the Cache API). The front door (default) is uncached so it always runs; it forwards every
		// deterministic GET /v1/* to the cache-enabled Api over ctx.exports, and reads DE440 blocks / geoid bands from the
		// cache-enabled BlockStore. MetarFeed (weather) is cached by its Cache-Control (src/metar-feed.ts). crossVersionCache
		// (Worker-wide) keeps the feed warm across deploys; every loopback key carries CACHE_VERSION (src/cache-version.ts,
		// bumped by hand, enforced by test/golden.test.ts) (ivar, 2026-10-29). Admin is RPC only (RPC bypasses the cache anyway).
		cache: { enabled: false, crossVersionCache: true },
		exports: {
			default: exports.worker({ cache: { enabled: false } }),
			MetarFeed: exports.worker({ cache: { enabled: true } }),
			// src/compute.ts: every deterministic /v1 answer and search window; DE440 blocks and EGM96 bands from R2.
			Api: exports.worker({ cache: { enabled: true } }),
			BlockStore: exports.worker({ cache: { enabled: true } }),
			// src/og-render.ts: the link-preview PNG per rounded place and 10-minute bucket (public, max-age=600), rendered by glyph.
			Og: exports.worker({ cache: { enabled: true } }),
		},
		// ephem-tail (packages/tail): one ephem_invocations row per invocation, incl. exceededCpu / exceededMemory / exception.
		tailConsumers: [{ worker: "ephem-tail" }],
		env: {
			EPH: bindings.r2({ name: "ephem-de440" }),   // BlockStore range reads; Admin (ingest)
			GEOID: bindings.r2({ name: "ephem-geoid" }), // EGM96 bands, BlockStore (src/geoid.ts)
			// Basin stream ephem_requests (schema ops/basin/requests.schema.json): one row per request, with its trace ids (src/requestlog.ts).
			LOGS: bindings.pipeline({ name: "09e37fce23fb4357ac54dff083a02f87" }),
			// ephem_rum (ops/basin/rum.schema.json): browser RUM spans from POST /rum (src/rum.ts).
			RUM: bindings.pipeline({ name: "3f7057f2350a4c7695ac6046305ac339" }),
			VERSION: bindings.versionMetadata(),
			// glyph (github.com/ivarvong/glyph): JSON scene → PNG, the Og entrypoint's renderer. A service binding: a public fetch
			// from one *.ivar.workers.dev Worker to another is refused (same zone); glyph fetches our font from this version's
			// preview URL (<id[0:8]>-ephem.ivar.workers.dev, src/og-fonts.ts), so a canary renders with its own font.
			GLYPH: bindings.worker({ worker: "glyph" }),
			REQUEST_LOGS: bindings.text("on"), // "off": no rows (logging-overhead A/B)
		},
	},
});
