// The one hand-maintained cache tag (ivar, 2026-10-29: "Turn on cross version, but we keep our own version tag in code if we
// need to bump"). crossVersionCache is on, so cached answers and data survive deploys; bump this when a deterministic answer
// or a loopback response format changes. test/golden.test.ts fails if answers change while this does not
// (`npm run golden:record` re-records after a bump). It scopes every loopback key (src/loopback.ts):
//   Api /v<N>/<path?sorted query> · BlockStore /block/v<N>/<sha16>/<i> · MetarFeed /feed/v<N>/metars.cache.csv.gz
export const CACHE_VERSION = 3   // 2: one refraction model (34′-anchored) for every endpoint · 3: live bump→MISS check (answers unchanged)
export const CACHE_TAG = `v${CACHE_VERSION}`
