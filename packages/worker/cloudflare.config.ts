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
		// Workers Caching (never the Cache API). The front door (default) is uncached so it always runs; it forwards GET /v1/*
		// to Api through ctx.exports. Api, BlockStore and MetarFeed are cached by their Cache-Control (src/responses.ts,
		// src/blocks.ts, src/metar-feed.ts). crossVersionCache (Worker-wide) keeps answers, DE440 blocks and the METAR feed warm
		// across deploys; every loopback key carries CACHE_VERSION (src/cache-version.ts, bumped by hand, enforced by
		// test/golden.test.ts) (ivar, 2026-10-29). Admin is RPC only (RPC bypasses the cache anyway).
		cache: { enabled: false, crossVersionCache: true },
		exports: {
			default: exports.worker({ cache: { enabled: false } }),
			Api: exports.worker({ cache: { enabled: true } }),
			BlockStore: exports.worker({ cache: { enabled: true } }),
			MetarFeed: exports.worker({ cache: { enabled: true } }),
		},
		// ephem-tail (packages/tail): one ephem_invocations row per invocation, incl. exceededCpu / exceededMemory / exception.
		tailConsumers: [{ worker: "ephem-tail" }],
		env: {
			EPH: bindings.r2({
				name: "ephem-de440",
			}),
			// EGM96 geoid bands (one sha-addressed object, scripts/geoid-r2.ts); read by BlockStore, src/geoid.ts.
			GEOID: bindings.r2({ name: "ephem-geoid" }),
			// Basin stream ephem_requests (schema ops/basin/requests.schema.json); request rows, src/requestlog.ts.
			LOGS: bindings.pipeline({ name: "d43e9589a2784812afda39033b6792eb" }),
			VERSION: bindings.versionMetadata(),
			REQUEST_LOGS: bindings.text("on"), // "off": no rows (logging-overhead A/B)
		},
	},
});
