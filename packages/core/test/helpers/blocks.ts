// Block source for tests: fixtures first, then data/jpl/blocks, then a one-time range fetch from JPL (dev only).
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { DE440, blockByteRange } from "../../src/block.ts"
const FIX = resolve(__dirname, "../fixtures/blocks"), DEV = resolve(__dirname, "../../../../data/jpl/blocks")
const URL = "https://ssd.jpl.nasa.gov/ftp/eph/planets/Linux/de440/linux_p1550p2650.440"
const cache = new Map<number, ArrayBuffer>()
export const diskBlocks = (i: number): ArrayBuffer => {
  const hit = cache.get(i); if (hit) return hit
  let fn = `${FIX}/${i}.bin`
  if (!existsSync(fn)) {
    fn = `${DEV}/${i}.bin`
    if (!existsSync(fn)) {
      if (process.env.CI) throw new Error(`block ${i} missing from fixtures (run reference/oracle/fixtures.py)`)
      mkdirSync(DEV, { recursive: true }); const [a, b] = blockByteRange(i)
      execFileSync("curl", ["-fsS", "-o", fn, "-r", `${a}-${b}`, URL])
    }
  }
  const buf = readFileSync(fn); if (buf.byteLength !== DE440.recBytes) throw new Error(`bad block ${i}`)
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
  cache.set(i, ab); return ab
}
