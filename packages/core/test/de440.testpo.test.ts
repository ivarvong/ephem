import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { Body, DE440, blockIndex, evalBlock, type BodyIndex, type State } from "../src/block.ts"
import { earthSsb } from "../src/ephemeris.ts"
import type { Vec3 } from "../src/linalg.ts"

const dataDir = resolve(__dirname, "../../../data/jpl")
const sample = JSON.parse(readFileSync(resolve(dataDir, "testpo_sample.json"), "utf8")) as
  ReadonlyArray<{ jd: number; t: number; c: number; x: number; val: number }>

const loadBlock = (i: number): ArrayBuffer => {
  const b = readFileSync(resolve(dataDir, `blocks/${i}.bin`))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
}

const zero: State = { pos: [0, 0, 0], vel: [0, 0, 0] }
const sub = (a: State, b: State): State => ({
  pos: a.pos.map((v, i) => v - b.pos[i]!) as unknown as Vec3,
  vel: a.vel.map((v, i) => v - b.vel[i]!) as unknown as Vec3,
})

/** testpo code → SSB-relative state in km. 3 = Earth, 10 = Moon, 11 = Sun, 12 = SSB, 13 = EMB. */
const ssbState = (block: ArrayBuffer, code: number, jd: number): State => {
  if (code === 12) return zero
  if (code === 13) return evalBlock(block, Body.EMB, jd)
  if (code === 3) return earthSsb(() => block, jd)
  if (code === 10) { const e = earthSsb(() => block, jd), m = evalBlock(block, Body.Moon, jd)
    return { pos: [e.pos[0] + m.pos[0], e.pos[1] + m.pos[1], e.pos[2] + m.pos[2]], vel: [e.vel[0] + m.vel[0], e.vel[1] + m.vel[1], e.vel[2] + m.vel[2]] } }
  if (code === 11) return evalBlock(block, Body.Sun, jd)
  const idx: Record<number, BodyIndex> = { 1: 0, 2: 1, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8 }
  return evalBlock(block, idx[code]!, jd)
}

describe("DE440 block evaluator vs JPL testpo.440", () => {
  it.each(sample.map(r => [r.jd, r.t, r.c, r.x, r.val] as const))("jd %f  t%i c%i x%i", (jd, t, c, x, expected) => {
    const block = loadBlock(blockIndex(jd))
    let got: number
    if (t === 14) {                                   // nutations: Δψ, Δε (x=1,2), rates (x=3,4) in rad, rad/day
      const n = evalBlock(block, Body.Nutations, jd)
      got = [n.pos[0], n.pos[1], n.vel[0], n.vel[1]][x - 1]!
    } else if (t === 15) {
      const l = evalBlock(block, Body.Librations, jd)
      got = [...l.pos, ...l.vel][x - 1]!
    } else {
      const s = sub(ssbState(block, t, jd), ssbState(block, c, jd))
      got = ([...s.pos, ...s.vel][x - 1]!) / DE440.au  // km → AU, km/day → AU/day
    }
    expect(Math.abs(got - expected)).toBeLessThan(1e-13)
  })
})
