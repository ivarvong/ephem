// Local server over the same handler. Origin = range reads of a local copy of the DE440 file (data/jpl/), so the
// cross-check harness exercises the exact R2 byte-range path without Cloudflare.
//   node --experimental-strip-types packages/worker/src/dev.ts [port]
import { createServer } from "node:http"
import { open } from "node:fs/promises"
import { resolve } from "node:path"
import { DE440, setGeoidSource } from "@ephem/core"
import { bundledGeoidBand } from "../../core/src/geoid-bundled.ts"
import { REC, blockOffset, direct, makeBlocks } from "./blocks.ts"
import { makeHandler } from "./app.ts"
import { makeFeed, serveFeed } from "./metar-feed.ts"
import { weatherLive } from "./weather.ts"

const FILE = resolve(import.meta.dirname, "../../../data/jpl", DE440.file)
const fh = await open(FILE, "r")
const blocks = makeBlocks(direct(async (first, count) => {
  const b = Buffer.alloc(count * REC); await fh.read(b, 0, b.length, blockOffset(first))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}))
// METARs from aviationweather.gov through the MetarFeed code with no cache in front: one upstream GET per weather request
const handler = makeHandler(blocks, undefined, weatherLive(makeFeed({ fetch: req => serveFeed(req, { fetch: (u, i) => fetch(u, i) }) })))
setGeoidSource(bundledGeoidBand)   // the grid from the source tree; prod reads bands from R2 (src/geoid.ts)
const port = Number(process.argv[2] ?? 8787)

createServer(async (req, res) => {
  const r = await handler(new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, { method: req.method ?? "GET", headers: req.headers as Record<string, string> }))
  res.writeHead(r.status, Object.fromEntries(r.headers))
  res.end(Buffer.from(await r.arrayBuffer()))
}).listen(port, "127.0.0.1", () => console.log(`ephem dev server on http://127.0.0.1:${port} (DE440 from ${FILE})`))
