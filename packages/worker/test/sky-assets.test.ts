// The homepage's DE440 blocks route (src/sky-assets.ts): the bytes the API reads, immutable; anything else a 404.
import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { DE440 } from "@ephem/core"
import { diskBlocks } from "../../core/test/helpers/blocks.ts"
import { DE440_ASSET_BASE } from "../src/sky-assets.ts"
import { makeHandler } from "../src/app.ts"
import { direct, makeBlocks } from "../src/blocks.ts"

const FILE = resolve(__dirname, "../../../data/jpl", DE440.file)
const whole = existsSync(FILE) ? readFileSync(FILE) : undefined
const src = (i: number): ArrayBuffer => whole ? whole.buffer.slice(whole.byteOffset + (2 + i) * DE440.recBytes, whole.byteOffset + (3 + i) * DE440.recBytes) as ArrayBuffer : diskBlocks(i)

describe("the DE440 block route", () => {
  const h = makeHandler(makeBlocks(direct(async i => src(i))))
  it("serves the API's block bytes, immutable; anything else is a 404", async () => {
    const blk = await h(new Request(`http://x${DE440_ASSET_BASE}5442`))
    expect(blk.status).toBe(200); expect(blk.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(Buffer.from(await blk.arrayBuffer()).equals(Buffer.from(src(5442)))).toBe(true)
    for (const p of [`${DE440_ASSET_BASE}12556`, `${DE440_ASSET_BASE}-1`, `${DE440_ASSET_BASE}1e3`, "/assets/de440/0000000000000000/5442", "/assets/0000000000000000/ephem-sky.js"])
      expect((await h(new Request(`http://x${p}`))).status, p).toBe(404)
  })
})
