// The homepage's browser bundle: exactly the functions /v1/position, /v1/track and /v1/day run on the server, and the block
// arithmetic to know which DE440 blocks they read. No geoid (the page is handed N as a number), no WMM, no search.
// Imported by @ephem/web (packages/web/src/client/core.ts) and bundled by Vite into the page's lazily loaded core module (a
// content-hashed static asset); packages/web/test/build.test.ts lists its modules, test/core-parity.test.ts runs the parity.
// Not exported from index.ts.
export { position } from "./position.ts"
export { track } from "./track.ts"
export { day } from "./day.ts"
export { DE440, blockIndex } from "./block.ts"
export { instant } from "./time.ts"
