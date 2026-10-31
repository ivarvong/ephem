// @ephem/core in the browser: exactly the functions /v1/position, /v1/track and /v1/day run on the server (the same source,
// bundled by Vite), loaded by the homepage after its first frame. A build entry of its own, so its exports keep their names:
// test/core-bundle.test.ts imports the built file and runs it against the API's server path (parity), and test/bundle.test.ts
// checks it carries no geoid, WMM or search.
export { position, track, day } from "@ephem/core/browser"
