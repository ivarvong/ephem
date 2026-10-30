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
		// deterministic GET /v1/* to ephem-compute's Api over the COMPUTE service binding (packages/compute; the callee's
		// Workers Caching applies), and reads DE440 blocks / geoid bands for live routes from ephem-compute's BlockStore (STORE).
		// MetarFeed (weather, front door only) stays here, cached by its Cache-Control (src/metar-feed.ts). crossVersionCache
		// (Worker-wide) keeps the feed warm across deploys; every loopback key carries CACHE_VERSION (src/cache-version.ts,
		// bumped by hand, enforced by test/golden.test.ts) (ivar, 2026-10-29). Admin is RPC only (RPC bypasses the cache anyway).
		cache: { enabled: false, crossVersionCache: true },
		exports: {
			default: exports.worker({ cache: { enabled: false } }),
			MetarFeed: exports.worker({ cache: { enabled: true } }),
		},
		// ephem-tail (packages/tail): one ephem_invocations row per invocation, incl. exceededCpu / exceededMemory / exception.
		tailConsumers: [{ worker: "ephem-tail" }],
		env: {
			EPH: bindings.r2({ name: "ephem-de440" }),   // Admin (ingest) only; blocks are read by ephem-compute's BlockStore
			// ephem-compute (packages/compute): deploy it first when its interface changes (scripts/deploy.sh does).
			COMPUTE: bindings.worker({ worker: "ephem-compute", exportName: "Api" }),
			STORE: bindings.worker({ worker: "ephem-compute", exportName: "BlockStore" }),
			// Basin stream ephem_requests (schema ops/basin/requests.schema.json); request rows, src/requestlog.ts.
			LOGS: bindings.pipeline({ name: "d43e9589a2784812afda39033b6792eb" }),
			VERSION: bindings.versionMetadata(),
			REQUEST_LOGS: bindings.text("on"), // "off": no rows (logging-overhead A/B)
		},
	},
});
