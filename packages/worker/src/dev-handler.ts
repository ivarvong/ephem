// The local server's handler (src/dev.ts loads this through Vite, which compiles the page components' TSX): the same app,
// with blocks range-read from a local copy of the DE440 file (data/jpl/), the EGM96 grid from the source tree, and METARs from
// aviationweather.gov through the MetarFeed code with no cache in front.
import { open } from "node:fs/promises"
import { resolve } from "node:path"
import { DE440, setGeoidSource } from "@ephem/core"
import { setDevAssets } from "@ephem/web/server"
import { bundledGeoidBand } from "../../core/src/geoid-bundled.ts"
import { REC, blockOffset, direct, makeBlocks } from "./blocks.ts"
import { makeHandler } from "./app.ts"
import { makeFeed, serveFeed } from "./metar-feed.ts"
import { weatherLive } from "./weather.ts"

export const FILE = resolve(import.meta.dirname, "../../../data/jpl", DE440.file)
/** `vite`: pages load Vite's dev modules (HMR) instead of the build. */
export const devHandler = async (vite: boolean) => {
  const fh = await open(FILE, "r")
  const blocks = makeBlocks(direct(async (first, count) => {
    const b = Buffer.alloc(count * REC); await fh.read(b, 0, b.length, blockOffset(first))
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
  }))
  setGeoidSource(bundledGeoidBand)   // the grid from the source tree; prod reads bands from R2 (src/geoid.ts)
  if (vite) setDevAssets()
  return makeHandler(blocks, undefined, weatherLive(makeFeed({ fetch: req => serveFeed(req, { fetch: (u, i) => fetch(u, i) }) })))
}
