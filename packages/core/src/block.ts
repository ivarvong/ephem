// Pure evaluator for one 32-day block of JPL's linux_p1550p2650.440.
// No I/O. The Worker fetches bytes [(2 + i) * REC_BYTES, +REC_BYTES) and hands them here.
// Reference port: github.com/ivarvong/de440 (lib/de440/internal.ex).

export const DE440 = {
  file: "linux_p1550p2650.440",
  url: "https://ssd.jpl.nasa.gov/ftp/eph/planets/Linux/de440/linux_p1550p2650.440",
  sizeBytes: 102_272_352,
  sha256: "29915576d0a6555766b99485ac3056ee415e86df4fce282611c31afb329ad062",
  numde: 440,
  jdStart: 2287184.5,
  jdEnd: 2688976.5,
  blockDays: 32,
  ncoeff: 1018,
  recBytes: 1018 * 8, // 8144
  nBlocks: 12556,
  au: 149597870.7,
  emrat: 81.30056822149722,
  // ipt: [coeffOffset (1-based doubles within record), ncoef per component, n sub-intervals]
  ipt: [
    [3, 14, 4], // 0 Mercury
    [171, 10, 2], // 1 Venus
    [231, 13, 2], // 2 EMB
    [309, 11, 1], // 3 Mars
    [342, 8, 1], // 4 Jupiter
    [366, 7, 1], // 5 Saturn
    [387, 6, 1], // 6 Uranus
    [405, 6, 1], // 7 Neptune
    [423, 6, 1], // 8 Pluto
    [441, 13, 8], // 9 Moon (geocentric)
    [753, 11, 2], // 10 Sun
    [819, 10, 4], // 11 Nutations (Δψ, Δε) — 2 components
    [899, 10, 4], // 12 Librations — 3 components
  ],
} as const

export type BodyIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12
export const Body = {
  Mercury: 0,
  Venus: 1,
  EMB: 2,
  Mars: 3,
  Jupiter: 4,
  Saturn: 5,
  Uranus: 6,
  Neptune: 7,
  Pluto: 8,
  Moon: 9,
  Sun: 10,
  Nutations: 11,
  Librations: 12,
} as const satisfies Record<string, BodyIndex>

const ncomp = (b: BodyIndex): 2 | 3 => (b === 11 ? 2 : 3)

import type { Vec3 } from "./linalg.ts"
export interface State {
  readonly pos: Vec3
  readonly vel: Vec3
} // km, km/day (nutations: rad, rad/day)

export const blockIndex = (jdTdb: number): number =>
  Math.min(DE440.nBlocks - 1, Math.floor((jdTdb - DE440.jdStart) / DE440.blockDays))

export const blockByteRange = (i: number): readonly [start: number, endInclusive: number] => [
  (2 + i) * DE440.recBytes,
  (3 + i) * DE440.recBytes - 1,
]

// Coefficients as a plain double array, made once per block, and plain scratch for Chebyshev T_k, T'_k (n ≤ 14; evalBlock is
// synchronous). Typed-array element access is the hot path here, and it is slower than plain arrays under V8's sandbox (workerd).
const coeffs = new WeakMap<ArrayBuffer, number[]>()
const T: number[] = Array.from({ length: 16 }, () => 0),
  dT: number[] = Array.from({ length: 16 }, () => 0)

// One component's series Σ a_k T_k (and Σ a_k T'_k) into sp, sv: no closure or tuple per call (evalBlock is the hottest
// allocation site of a search window otherwise).
let sp = 0,
  sv = 0
const series = (f: number[], o: number, n: number, withVel: boolean): void => {
  let p = 0,
    v = 0
  if (withVel)
    for (let k = 0; k < n; k++) {
      const a = f[o + k]!
      p += a * T[k]!
      v += a * dT[k]!
    }
  else for (let k = 0; k < n; k++) p += f[o + k]! * T[k]!
  sp = p
  sv = v
}

/** Position (and velocity) of `body` at `jdTdb` from the block that covers it. Throws RangeError if the block does not.
 *  `withVel = false` skips the derivative series (velocity reads zero); positions are bit-identical either way. */
export const evalBlock = (block: ArrayBuffer, body: BodyIndex, jdTdb: number, withVel = true): State => {
  if (block.byteLength !== DE440.recBytes)
    throw new RangeError(`block is ${block.byteLength} B, expected ${DE440.recBytes}`)
  let f = coeffs.get(block)
  if (!f) {
    f = Array.from(new Float64Array(block))
    coeffs.set(block, f)
  }
  const jd0 = f[0]!,
    jd1 = f[1]!
  if (jdTdb < jd0 || jdTdb > jd1) throw new RangeError(`jd ${jdTdb} outside block [${jd0}, ${jd1}]`)

  const ipt = DE440.ipt[body]!,
    off1 = ipt[0],
    n = ipt[1],
    nsub = ipt[2]
  const nc = ncomp(body)
  const subDays = (jd1 - jd0) / nsub
  const sub = Math.min(nsub - 1, Math.floor((jdTdb - jd0) / subDays))
  const t0 = jd0 + sub * subDays
  const tc = (2 * (jdTdb - t0)) / subDays - 1 // ∈ [-1, 1]
  const base = off1 - 1 + sub * n * nc // ipt offsets are 1-based

  // Chebyshev T_k and T'_k by recurrence (same as the Elixir port; Clenshaw would also do).
  T[0] = 1
  dT[0] = 0
  if (n > 1) {
    T[1] = tc
    dT[1] = 1
  }
  for (let k = 2; k < n; k++) T[k] = 2 * tc * T[k - 1]! - T[k - 2]!
  if (withVel) for (let k = 2; k < n; k++) dT[k] = 2 * T[k - 1]! + 2 * tc * dT[k - 1]! - dT[k - 2]!
  const velScale = 2 / subDays // d(tc)/d(day)
  series(f, base, n, withVel)
  const x = sp,
    vx = sv * velScale
  series(f, base + n, n, withVel)
  const y = sp,
    vy = sv * velScale
  let z = 0,
    vz = 0
  if (nc === 3) {
    series(f, base + 2 * n, n, withVel)
    z = sp
    vz = sv * velScale
  }
  return { pos: [x, y, z], vel: [vx, vy, vz] }
}
