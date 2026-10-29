// Barycentric states from DE440 blocks. The caller owns I/O: it supplies a BlockSource that returns
// the 8 144-byte record for a block index synchronously (prefetched for the instants it will ask about).
import { Body, DE440, blockIndex, evalBlock, type State } from "./block.ts"
import { add, scale, sub, type Vec3 } from "./linalg.ts"

export type BlockSource = (index: number) => ArrayBuffer


export const AU_KM = DE440.au
export const C_KM_PER_DAY = 299792.458 * 86400

const at = (src: BlockSource, body: number, jdTdb: number, withVel = true): State => evalBlock(src(blockIndex(jdTdb)), body as never, jdTdb, withVel)

/** Earth (geocentre) relative to the solar-system barycentre, km and km/day. */
const earthFrom = (emb: State, moon: State): State => {
  const k = 1 / (1 + DE440.emrat)
  return { pos: sub(emb.pos, scale(moon.pos, k)), vel: sub(emb.vel, scale(moon.vel, k)) }
}
export const earthSsb = (src: BlockSource, jdTdb: number): State => earthFrom(at(src, Body.EMB, jdTdb), at(src, Body.Moon, jdTdb))
export const sunSsb = (src: BlockSource, jdTdb: number, withVel = true): State => at(src, Body.Sun, jdTdb, withVel)
export const moonSsb = (src: BlockSource, jdTdb: number, withVel = true): State => {
  const m = at(src, Body.Moon, jdTdb, withVel), e = earthFrom(at(src, Body.EMB, jdTdb, withVel), m)   // one Moon evaluation, not two
  return { pos: add(e.pos, m.pos), vel: add(e.vel, m.vel) }
}
/** DE440's tabulated nutation angles (Δψ, Δε), radians. */
export const nutation = (src: BlockSource, jdTdb: number): readonly [number, number] => {
  const n = at(src, Body.Nutations, jdTdb, false); return [n.pos[0], n.pos[1]]
}

export type BodyName = "sun" | "moon"
export const bodySsb = (src: BlockSource, body: BodyName, jdTdb: number): Vec3 =>
  (body === "sun" ? sunSsb(src, jdTdb, false) : moonSsb(src, jdTdb, false)).pos

/** Block indices needed to evaluate anything in [jdTdbFrom, jdTdbTo] (inclusive), with light-time margin. */
export const blocksFor = (jdTdbFrom: number, jdTdbTo: number): number[] => {
  const a = blockIndex(jdTdbFrom - 0.01), b = blockIndex(jdTdbTo + 0.01), out: number[] = []
  for (let i = a; i <= b; i++) out.push(i)
  return out
}

/** Wrap a source to record which blocks were read and how many times — the basis of response diagnostics. */
export const instrumented = (src: BlockSource): { readonly src: BlockSource; readonly stats: { reads: number; blocks: Set<number> } } => {
  const stats = { reads: 0, blocks: new Set<number>() }
  return { src: i => { stats.reads++; stats.blocks.add(i); return src(i) }, stats }
}
