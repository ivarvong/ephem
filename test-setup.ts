// Every test file: core's EGM96 band source is the grid from the source tree (prod reads bands from R2, src/geoid.ts).
// Tests that exercise the R2 path install their own source (makeGeoid / setGeoidSource).
import { setGeoidSource } from "./packages/core/src/geoid.ts"
import { bundledGeoidBand } from "./packages/core/src/geoid-bundled.ts"
setGeoidSource(bundledGeoidBand)
