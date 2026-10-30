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
		},
		// ephem-tail (packages/tail): one ephem_invocations row per invocation, incl. exceededCpu / exceededMemory / exception.
		tailConsumers: [{ worker: "ephem-tail" }],
		env: {
			EPH: bindings.r2({ name: "ephem-de440" }),   // BlockStore range reads; Admin (ingest)
			GEOID: bindings.r2({ name: "ephem-geoid" }), // EGM96 bands, BlockStore (src/geoid.ts)
			// Basin stream ephem_requests (schema ops/basin/requests.schema.json); request rows, src/requestlog.ts.
			LOGS: bindings.pipeline({ name: "d43e9589a2784812afda39033b6792eb" }),
			// ephem_requests_v2 (ops/basin/requests_v2.schema.json): v1 + trace ids, dual-written until readers move.
			LOGS_V2: bindings.pipeline({ name: "82c448efe29b4e61ad0a7c8f9593f747" }),
			// ephem_rum (ops/basin/rum.schema.json): browser RUM spans from POST /rum (src/rum.ts).
			RUM: bindings.pipeline({ name: "3f7057f2350a4c7695ac6046305ac339" }),
			VERSION: bindings.versionMetadata(),
			REQUEST_LOGS: bindings.text("on"), // "off": no rows (logging-overhead A/B)
		},
	},
});
