import { bindings, defineConfig, exports } from "cf/config";

// ephem-load: open-loop load at ephem from Generator Durable Objects in several regions (guide "Load"; db-load's pattern).
// Deploy: scripts/deploy.sh main "…" load. Secret LOAD_TOKEN (cf workers secrets bulk; the token lives in ~/.config/ephem-load/token).
// global_fetch_strictly_public: ephem is on the same workers.dev subdomain, and a Worker's fetch to a Worker on its own zone is
// otherwise refused (error 1042); with it the request goes out through the public front door, like an eyeball's.
export default defineConfig({
	worker: {
		name: "ephem-load",
		compatibilityDate: "2026-10-01",
		compatibilityFlags: ["global_fetch_strictly_public"],
		entrypoint: "src/index.ts",
		observability: { enabled: true },
		env: { VERSION: bindings.versionMetadata() }, // /health and x-ephem-load-version: deploy.sh waits for the new version
		exports: {
			Generator: exports.durableObject({ storage: "sqlite" }),
			Coordinator: exports.durableObject({ storage: "sqlite" }),
		},
	},
});
