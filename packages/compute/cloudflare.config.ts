import { bindings, defineConfig, exports } from "cf/config";

// ephem-compute: ephem's CPU-heavy cache-enabled entrypoints (Api, BlockStore) in their own Worker, so their misses run in
// their own isolate pool and never make the platform spawn front-door isolates (docs/telemetry_and_profiling.md "Compute
// split"). Code: packages/worker/src/compute.ts. No public route: ephem's front door calls it over service bindings
// (COMPUTE → Api, STORE → BlockStore). Workers Caching (never the Cache API): Api and BlockStore cached by their
// Cache-Control; crossVersionCache on, every key carries CACHE_VERSION (src/cache-version.ts) (ivar, 2026-10-29).
export default defineConfig({
	worker: {
		name: "ephem-compute",
		compatibilityDate: "2026-10-01",
		entrypoint: "src/index.ts",
		workersDev: false,
		previewUrls: false,
		observability: {
			enabled: true,
			traces: { enabled: true, headSamplingRate: 1 },
		},
		cache: { enabled: false, crossVersionCache: true },
		exports: {
			default: exports.worker({ cache: { enabled: false } }),
			Api: exports.worker({ cache: { enabled: true } }),
			BlockStore: exports.worker({ cache: { enabled: true } }),
		},
		// ephem-tail: one ephem_invocations row per invocation (entrypoint labelled "ephem-compute/<entrypoint>").
		tailConsumers: [{ worker: "ephem-tail" }],
		env: {
			EPH: bindings.r2({ name: "ephem-de440" }),       // read only (BlockStore range reads); never written from here
			GEOID: bindings.r2({ name: "ephem-geoid" }),     // EGM96 bands, src/geoid.ts
			LOGS: bindings.pipeline({ name: "d43e9589a2784812afda39033b6792eb" }),   // Basin ephem_requests, role "api" rows
			VERSION: bindings.versionMetadata(),
			REQUEST_LOGS: bindings.text("on"),
		},
	},
});
