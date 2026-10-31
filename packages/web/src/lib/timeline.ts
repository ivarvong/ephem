// The mission timeline as geometry. Pure; test/timeline.test.ts runs it over many dates and latitudes (bounding boxes).
//
// A window of time (the page: now − 3 h … now + 21 h, so now sits at an eighth and the next events are always on it) with
// twilight as shading on the line (from the Sun's altitude samples: day, civil, nautical, astronomical, night); nodes for
// sunrise, solar noon, sunset, moonrise and moonset, plus the NEXT event (highlighted) if it is something else. Events whose
// nodes would sit within MERGE px share one node and one stacked label ("SOLAR NOON · MOONSET" over "12:39 · 13:29"), so no
// two nodes ever overlap. Sun labels go above the line, Moon labels below (a label of both, above); a label with no room in
// its row tries the other, else is left out (its node stays). A leader runs only across the gap between the line and its label.
import type { BodyKey } from "./types.ts"

export interface TlEvent { readonly body: BodyKey; readonly kind: string; readonly t: number }
export type TlPhase = "day" | "civil" | "nautical" | "astro" | "night"
export interface TlSeg { x0: number; x1: number; readonly kind: TlPhase }
export interface TlNode { readonly x: number; readonly body: BodyKey; readonly bodies: ReadonlyArray<BodyKey>; readonly kind: string; readonly past: boolean; readonly next: boolean }
export interface TlLabel { readonly x: number; readonly y: number; readonly w: number; readonly h: number; readonly name: string; readonly time: string; readonly cx: number; readonly past: boolean; readonly next: boolean; readonly body: BodyKey }
export interface TlLayout {
  readonly mid: number; readonly h: number
  /** half-height (px) of the NOW bar and the scrub cursor, whole inside the gap between the line and the label rows */
  readonly mark: number
  readonly segs: TlSeg[]; readonly nodes: TlNode[]; readonly labels: TlLabel[]; readonly leaders: Array<[number, number, number, number]>
}

const TL_NODE: Readonly<Record<BodyKey, Readonly<Record<string, 1>>>> = { sun: { rise: 1, transit: 1, set: 1 }, moon: { rise: 1, set: 1 } }
export const TL_MERGE = 16
/** Left/right padding of the line inside the timeline's width (px). */
export const TL_PAD = 10

// ---- scrub math: the window [s0, s0 + span) on a line of w px (TL_PAD each side) ----
const clamp01 = (u: number) => Math.max(0, Math.min(1, u))
/** The x (px) of instant t; clamped to the line's ends. */
export const tlX = (s0: number, span: number, w: number, t: number): number => TL_PAD + clamp01((t - s0) / span) * (w - 2 * TL_PAD)
/** The instant at x (px); clamped to the window, whose end is exclusive. */
export const tlTime = (s0: number, span: number, w: number, x: number): number => s0 + clamp01((x - TL_PAD) / (w - 2 * TL_PAD)) * (span - 1)
/** The scrub offset (ms from `base`, the live instant) for a wish to see instant t: held inside the window. */
export const scrubOffset = (s0: number, span: number, t: number, base: number): number => Math.max(s0, Math.min(s0 + span - 1, t)) - base
/** A marker's x on a half-pixel grid (it moves only when it moves visibly). */
export const halfPx = (x: number): number => Math.round(x * 2) / 2

// ---- the scrub cursor on a node ----
/** Half-width (px) of the NOW bar and the scrub cursor, page-coloured edge included (stroke 5). */
export const TL_BAR_HALF = 2.5
/** Radius (px) of the circle around the next event, and around the selected node (stroke 1.25 / 1.5, centred on it). */
export const TL_RING = 7
/** Half-width (px) of a node's marks: the next event's circle, else the disc (r 3.5, stroke 1.5). */
export const nodeExtent = (n: TlNode): number => (n.next ? TL_RING + 0.75 : 4.25)
/** The node the scrub cursor at x would touch, nearest first, or null. That node is drawn selected (circled in amber) and the
 *  cursor is not drawn, so the two never overlap (test/timeline.test.ts sweeps it). */
export const cursorNode = (nodes: ReadonlyArray<TlNode>, x: number): TlNode | null => {
  let best: TlNode | null = null, bd = Infinity
  for (const n of nodes) { const d = Math.abs(n.x - x); if (d < nodeExtent(n) + TL_BAR_HALF && d < bd) { best = n; bd = d } }
  return best
}

const phase = (a: number): TlPhase => (a >= -0.833 ? "day" : a >= -6 ? "civil" : a >= -12 ? "nautical" : a >= -18 ? "astro" : "night")

/**
 * evs: events; sun: the Sun's altitude samples; s0/span: the window; w: px; next: the next event or null; name(e) → caps name;
 * time(t) → "HH:MM"; meas(text, "name" | "time") → px; k: type scale (1.25 on wide screens).
 */
export const timelineLayout = (evs: ReadonlyArray<TlEvent>, sun: ReadonlyArray<{ readonly t: number; readonly alt: number }>, s0: number, span: number, w: number,
  now: number, next: TlEvent | null, name: (e: TlEvent) => string, time: (t: number) => string, meas: (text: string, kind: "name" | "time") => number, k = 1): TlLayout => {
  const mid = Math.round(46 * k), gap = Math.round(9 * k), lh = Math.round(13 * k)
  const X = (t: number) => tlX(s0, span, w, t)
  const out: TlLayout = { mid, h: mid + gap + 2 * lh + 4, mark: gap - 3, segs: [], nodes: [], labels: [], leaders: [] }
  for (let i = 1; i < sun.length; i++) {
    const ph = phase((sun[i - 1]!.alt + sun[i]!.alt) / 2), x0 = X(sun[i - 1]!.t), x1 = X(sun[i]!.t), last = out.segs[out.segs.length - 1]
    if (x1 <= x0) continue
    if (last && last.kind === ph && Math.abs(last.x1 - x0) < 0.01) last.x1 = x1; else out.segs.push({ x0, x1, kind: ph })
  }
  const isNext = (e: TlEvent) => !!next && next.body === e.body && next.kind === e.kind && Math.abs(next.t - e.t) < 60e3
  const pick = evs.filter(e => e.t >= s0 && e.t <= s0 + span && (TL_NODE[e.body]?.[e.kind] || isNext(e))).sort((a, b) => a.t - b.t)
  // one group per event, then neighbours whose nodes (each at its group's mean x) are closer than MERGE px merge, until none are
  const groups = pick.map(e => [e]), cx = (g: TlEvent[]) => g.reduce((s, e) => s + X(e.t), 0) / g.length
  for (let again = true; again;) {
    again = false
    for (let gi = 1; gi < groups.length; gi++) if (cx(groups[gi]!) - cx(groups[gi - 1]!) < TL_MERGE * k) { groups.splice(gi - 1, 2, groups[gi - 1]!.concat(groups[gi]!)); again = true; break }
  }
  const rows: Array<Array<{ x: number; w: number }>> = [[], []]
  for (const gp of groups) {
    const x = cx(gp), nm = gp.map(name).join(" · "), tm = gp.map(e => time(e.t)).join(" · ")
    const nx = gp.some(isNext), past = gp[gp.length - 1]!.t <= now, bw = Math.max(meas(nm, "name"), meas(tm, "time")), bodies = gp.map(e => e.body)
    const pref = bodies.every(b => b === "moon") ? 1 : 0
    out.nodes.push({ x, body: gp[0]!.body, bodies, kind: gp[0]!.kind, past, next: nx })
    let placed = false
    for (let tries = 0; tries < 2 && !placed; tries++) {
      const r = (pref + tries) % 2, bx = Math.max(0, Math.min(w - bw, x - bw / 2)), y = r === 0 ? mid - gap - 2 * lh : mid + gap
      const box = { x: bx, w: bw }
      if (rows[r]!.some(o => box.x < o.x + o.w + 8 && o.x < box.x + box.w + 8)) continue
      rows[r]!.push(box); placed = true
      out.labels.push({ x: bx, y, w: bw, h: 2 * lh, name: nm, time: tm, cx: x, past, next: nx, body: gp[0]!.body })
      if (x >= bx + 2 && x <= bx + bw - 2) out.leaders.push(r === 0 ? [x, mid - 5, x, y + 2 * lh + 1] : [x, mid + 5, x, y - 1])
    }
  }
  return out
}
