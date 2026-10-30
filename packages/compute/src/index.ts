// ephem-compute's entry: the code lives in packages/worker/src/compute.ts (shared router, handlers, blocks, geoid), so the
// two Workers can't drift and test/loopback.test.ts covers it. Deploy: scripts/deploy.sh <rev> "<msg>" compute (or auto).
export { default, Api, BlockStore } from "../../worker/src/compute.ts"
