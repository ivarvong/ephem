// Every test file: core's EGM96 band source is the grid from the source tree (prod reads bands from R2, src/geoid.ts).
// Tests that exercise the R2 path install their own source (makeGeoid / setGeoidSource).
import { setGeoidSource } from "./packages/core/src/geoid.ts"
import { bundledGeoidBand } from "./packages/core/src/geoid-bundled.ts"
setGeoidSource(bundledGeoidBand)

// fast-check: FC_SEED pins the seed (replay a failure; CI=1 pins 42). Otherwise each run draws a fresh seed, and a failing
// property's error carries `seed` and `path` (fast-check reports both); rerun with FC_SEED=<seed> to reproduce it.
import fc from "fast-check"
const fcSeed = process.env.FC_SEED ?? (process.env.CI ? "42" : undefined)
if (fcSeed !== undefined) fc.configureGlobal({ seed: Number(fcSeed) })
