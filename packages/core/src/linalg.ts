// Small, allocation-light 3-vector / 3×3 helpers. Matrices are row-major tuples.
export type Vec3 = readonly [number, number, number]
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number]

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2])
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

export const mxv = (m: Mat3, v: Vec3): Vec3 => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
]
export const mtxv = (m: Mat3, v: Vec3): Vec3 => [  // transpose(m) · v
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
]
export const mxm = (a: Mat3, b: Mat3): Mat3 => {
  const r = (i: number, j: number) => a[i * 3]! * b[j]! + a[i * 3 + 1]! * b[3 + j]! + a[i * 3 + 2]! * b[6 + j]!
  return [r(0, 0), r(0, 1), r(0, 2), r(1, 0), r(1, 1), r(1, 2), r(2, 0), r(2, 1), r(2, 2)]
}
export const transpose = (m: Mat3): Mat3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]

/** Active rotations (rotate a vector by +θ about the axis), matching Skyfield's rot_x / rot_z. */
export const rotX = (t: number): Mat3 => { const c = Math.cos(t), s = Math.sin(t); return [1, 0, 0, 0, c, -s, 0, s, c] }
export const rotY = (t: number): Mat3 => { const c = Math.cos(t), s = Math.sin(t); return [c, 0, s, 0, 1, 0, -s, 0, c] }
export const rotZ = (t: number): Mat3 => { const c = Math.cos(t), s = Math.sin(t); return [c, -s, 0, s, c, 0, 0, 0, 1] }

export const DEG = Math.PI / 180
export const ASEC = Math.PI / 648000
export const TAU = 2 * Math.PI
export const wrap360 = (d: number) => ((d % 360) + 360) % 360
