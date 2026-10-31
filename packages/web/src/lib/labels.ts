// Label layout for the sky chart: every label gets a spot that overlaps no text, disc, marker, reserved band or path line.
// Pure (no canvas); test/chart.test.ts runs it over every sky state and random skies.

export interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly id?: string
}
/** A segment [x1, y1, x2, y2]. */
export type Seg = readonly [number, number, number, number]
export interface Bounds {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

export const overlapArea = (a: Rect, b: Rect): number => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
    h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** Pairs of rects that overlap where at least one is text. */
export const overlaps = (rects: ReadonlyArray<Rect & { readonly text?: boolean }>): string[] => {
  const bad: string[] = []
  for (let i = 0; i < rects.length; i++)
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]!,
        b = rects[j]!
      if ((a.text || b.text) && overlapArea(a, b) > 0) bad.push(a.id + " x " + b.id)
    }
  return bad
}

/** Does segment s touch rect r? (Liang-Barsky clipping.) */
export const segHitsRect = (s: Seg, r: Rect): boolean => {
  const x1 = s[0],
    y1 = s[1],
    dx = s[2] - x1,
    dy = s[3] - y1
  let t0 = 0,
    t1 = 1
  const p = [-dx, dx, -dy, dy],
    q = [x1 - r.x, r.x + r.w - x1, y1 - r.y, r.y + r.h - y1]
  for (let i = 0; i < 4; i++) {
    const pi = p[i]!,
      qi = q[i]!
    if (pi === 0) {
      if (qi < 0) return false
      continue
    }
    const t = qi / pi
    if (pi < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
  }
  return true
}

export interface LabelItem {
  readonly id: string
  readonly w: number
  h: number
  readonly prio: number
  readonly x: number
  readonly y: number
  readonly r?: number
  readonly body?: boolean
  readonly must?: boolean
  readonly pad?: number
  readonly spots?: ReadonlyArray<readonly [number, number]>
  readonly t?: string
}
export interface Placed {
  readonly id: string
  readonly prio: number
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly crossed?: true
}
export interface Dropped {
  readonly id: string
  readonly prio: number
  readonly dropped: true
}
export type Laid = Placed | Dropped
export const isPlaced = (l: Laid): l is Placed => !("dropped" in l)

/** Candidate spots for a label around an anchor, nearest first: above, beside, below, then the diagonals, at growing distances. */
const spotsAround = (it: LabelItem): Array<[number, number]> => {
  const out: Array<[number, number]> = [],
    w = it.w,
    h = it.h
  for (const m of it.body ? [1, 1.7, 2.6, 3.8, 5.4, 7.5, 10] : [1, 1.7, 2.6, 3.8]) {
    // an event label stays by its marker, or goes
    const d = (it.r || 0) + 5 * m,
      e = d * 0.72
    out.push(
      [it.x - w / 2, it.y - d - h],
      [it.x + d, it.y - h / 2],
      [it.x - d - w, it.y - h / 2],
      [it.x - w / 2, it.y + d],
      [it.x + e, it.y - e - h],
      [it.x - e - w, it.y - e - h],
      [it.x + e, it.y + e],
      [it.x - e - w, it.y + e],
    )
    if (it.body)
      out.push([it.x + d, it.y - 2], [it.x - d - w, it.y - 2], [it.x + d, it.y - h + 2], [it.x - d - w, it.y - h + 2]) // beside, top- or bottom-aligned
  }
  return out
}
/** A body's name: many more candidates, nearest first (beside, above, below, out to ~90 px), so a clear spot is found before any fallback. */
// The spots are the same around every anchor, so they are built and sorted once per label size, as offsets from the anchor
// (the chart lays labels out on every scrub frame: ~2 000 spots and a sort per body per frame before).
const bodyOffsets = new Map<string, ReadonlyArray<readonly [number, number]>>()
const bodySpots = (it: LabelItem): Array<[number, number]> => {
  const R = it.r || 0,
    key = R + "|" + it.w + "|" + it.h
  let off = bodyOffsets.get(key)
  if (!off) {
    const o = spotsAround({ ...it, x: 0, y: 0 })
    for (let dy = -60; dy <= 60; dy += 4)
      for (let dx = 0; dx <= 90; dx += 6) {
        o.push([R + 4 + dx, -it.h / 2 + dy], [-R - 4 - dx - it.w, -it.h / 2 + dy])
        if (dx <= 40)
          o.push(
            [-it.w / 2 + (dy % 8 ? dx : -dx), -R - 4 - it.h - Math.abs(dy)],
            [-it.w / 2 + (dy % 8 ? dx : -dx), R + 4 + Math.abs(dy)],
          )
      }
    off = o
      .map((s) => [s, Math.hypot(s[0] + it.w / 2, s[1] + it.h / 2)] as const)
      .toSorted((a, b) => a[1] - b[1])
      .map((x) => x[0])
    bodyOffsets.set(key, off)
  }
  return off.map(([dx, dy]) => [it.x + dx, it.y + dy])
}
const segBox = (s: Seg): Rect => ({
  x: Math.min(s[0], s[2]),
  y: Math.min(s[1], s[3]),
  w: Math.abs(s[2] - s[0]),
  h: Math.abs(s[3] - s[1]),
})

/**
 * Every label goes through one layout, highest priority first. A label takes the first candidate spot (nearest first) inside
 * the bounds that touches, with pad px to spare, no hard rect (discs, markers, the horizon band, buttons), no label already
 * placed, and no path segment. A body's own label (and a `must` label), when every spot is crossed by a path, takes the nearest
 * spot clear of everything else (crossed). Anything else without a clear spot is dropped: a label never lands on a
 * higher-priority one. Returns the layout in priority order.
 */
export const layoutLabels = (
  items: ReadonlyArray<LabelItem>,
  hard: ReadonlyArray<Rect>,
  segs: ReadonlyArray<Seg>,
  bounds: Bounds,
  pad = 2,
): Laid[] => {
  const placed: Rect[] = [],
    out: Laid[] = [],
    sb = segs.map(segBox)
  const clearOf = (r: Rect, list: ReadonlyArray<Rect>) => {
    for (const o of list) if (overlapArea(r, o) > 0) return false
    return true
  }
  const crossed = (r: Rect) => {
    for (let j = 0; j < segs.length; j++) {
      const b = sb[j]!
      if (overlapArea(r, { x: b.x - 0.5, y: b.y - 0.5, w: b.w + 1, h: b.h + 1 }) > 0 && segHitsRect(segs[j]!, r))
        return true
    }
    return false
  }
  items
    .map((it, i) => ({ it, i }))
    .toSorted((a, b) => a.it.prio - b.it.prio || a.i - b.i)
    .forEach(({ it }) => {
      const spots = it.spots ?? (it.body ? bodySpots(it) : spotsAround(it))
      let best: Rect | null = null,
        fall: Rect | null = null
      for (const [x, y] of spots) {
        if (x < bounds.x0 || y < bounds.y0 || x + it.w > bounds.x1 || y + it.h > bounds.y1) continue
        const pd = it.pad ?? pad,
          r = { x, y, w: it.w, h: it.h },
          gr = { x: x - pd, y: y - pd, w: it.w + 2 * pd, h: it.h + 2 * pd }
        if (!clearOf(gr, hard) || !clearOf(gr, placed)) continue
        if (!crossed({ x: x - 3, y: y - 3, w: it.w + 6, h: it.h + 6 })) {
          best = r
          break
        }
        if ((it.body || it.must) && !fall) fall = r
      }
      let r2 = best ?? fall
      if (!r2 && it.body) {
        // a body is always named: the spot in bounds clear of the other labels that covers the least
        let least = Infinity
        for (const [x, y] of spots) {
          const q = { x, y, w: it.w, h: it.h }
          if (
            q.x < bounds.x0 ||
            q.y < bounds.y0 ||
            q.x + q.w > bounds.x1 ||
            q.y + q.h > bounds.y1 ||
            !clearOf(q, placed)
          )
            continue
          let cover = 0
          for (const hr of hard) cover += overlapArea(q, hr)
          if (cover < least) {
            least = cover
            r2 = q
          }
        }
      }
      if (!r2) {
        out.push({ id: it.id, dropped: true, prio: it.prio })
        return
      }
      const p: Placed = best ? { ...r2, id: it.id, prio: it.prio } : { ...r2, id: it.id, prio: it.prio, crossed: true }
      placed.push(p)
      out.push(p)
    })
  return out
}
