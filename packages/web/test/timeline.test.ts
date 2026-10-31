// The mission timeline over many places and dates, from core's own day events (the full local DE440 file when present): at
// 390 and 375 px (and desktop), no two nodes closer than their size plus a gap, no two labels overlapping (8 px apart in a
// row), every label inside the strip, and the NOW bar / scrub cursor never on a label at any position (bounding boxes).
import { describe, expect, it } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { DE440, day, track } from "@ephem/core"
import { diskBlocks } from "../../core/test/helpers/blocks.ts"
import { TL_BAR_HALF, TL_RING, cursorNode, nodeExtent, timelineLayout, type TlEvent } from "../src/lib/timeline.ts"
import { overlapArea } from "../src/lib/labels.ts"
import type { BodyKey } from "../src/lib/types.ts"

const FILE = resolve(__dirname, "../../../data/jpl", DE440.file),
  whole = existsSync(FILE) ? readFileSync(FILE) : undefined
const memo = new Map<number, ArrayBuffer>() // one ArrayBuffer per block: core caches its coefficients per buffer
const src = (i: number) => {
  let b = memo.get(i)
  if (!b) {
    b = whole
      ? (whole.buffer.slice(
          whole.byteOffset + (2 + i) * DE440.recBytes,
          whole.byteOffset + (3 + i) * DE440.recBytes,
        ) as ArrayBuffer)
      : diskBlocks(i)
    memo.set(i, b)
  }
  return b
}
const NAMES: Record<string, string> = { rise: "RISE", set: "SET", transit: "SOLAR NOON" }

describe("the timeline never overlaps (bounding boxes, 400 windows, markers every 5 px)", () => {
  let seed = 7
  const r = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  const zones = [
    "America/New_York",
    "Europe/Oslo",
    "Australia/Sydney",
    "Asia/Singapore",
    "Pacific/Auckland",
    "America/Anchorage",
    "UTC",
  ]
  it("390, 375 and 1100 px", () => {
    let windows = 0,
      merged = 0,
      other = 0,
      cursorOn = 0
    for (let n = 0; n < 400; n++) {
      const lat = -66 + 132 * r(),
        lon = -180 + 360 * r(),
        tz = zones[n % zones.length]!
      const now = Date.parse("2026-01-01T00:00:00Z") + Math.floor(r() * 365 * 864e5),
        s0 = now - 3 * 3600e3,
        span = 24 * 3600e3
      const geo = { lat, lon, height: 0 },
        evs: TlEvent[] = []
      for (let d = -1; d <= 1; d++) {
        const date = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(now + d * 864e5))
        for (const e of day(src, { date, tz, geo, limb: "upper" }).events)
          if (!evs.some((x) => x.kind === e.kind && x.body === e.body && x.t === Date.parse(e.time)))
            evs.push({ body: e.body as BodyKey, kind: e.kind, t: Date.parse(e.time) })
      }
      const t0 = Math.floor(s0 / 12e5) * 12e5
      const tr = track(src, {
        startMs: t0,
        endMs: Math.ceil((s0 + span) / 12e5) * 12e5,
        stepMs: 12e5,
        geo,
        temperature: 10,
        pressure: 1010,
        horizon: 0,
      })
      const sun = tr.sun.altitude.map((alt, i) => ({ t: t0 + i * 12e5, alt }))
      const nx = evs.filter((e) => e.t > now).toSorted((a, b) => a.t - b.t)[0] ?? null
      for (const [w, k] of [
        [358, 1],
        [343, 1],
        [1100, 1.25],
      ] as const) {
        const L = timelineLayout(
          evs,
          sun,
          s0,
          span,
          w,
          now,
          nx,
          (e) => (e.body === "moon" ? "MOON" : "SUN") + (NAMES[e.kind] ?? e.kind.toUpperCase()),
          (t) => new Date(t).toISOString().slice(11, 16),
          (t, kind) => Math.ceil(t.length * (kind === "name" ? 6.4 : 6.6) * k) + 4,
          k,
        )
        windows++
        const where = `${lat.toFixed(2)},${lon.toFixed(2)} ${new Date(now).toISOString()} ${w}px`
        const xs = L.nodes.map((nd) => nd.x).toSorted((a, b) => a - b)
        for (let i = 1; i < xs.length; i++)
          expect(xs[i]! - xs[i - 1]!, `${where}: nodes ${i - 1}, ${i}`).toBeGreaterThanOrEqual(16 * k - 0.01)
        merged += L.nodes.filter((nd) => nd.bodies.length > 1).length
        for (let i = 0; i < L.labels.length; i++) {
          const a = L.labels[i]!
          expect(a.x, where).toBeGreaterThanOrEqual(0)
          expect(a.x + a.w, where).toBeLessThanOrEqual(w)
          for (let j = i + 1; j < L.labels.length; j++)
            expect(overlapArea({ ...a, x: a.x - 4, w: a.w + 8 }, L.labels[j]!), `${where}: labels ${i} x ${j}`).toBe(0)
          if ((a.body === "moon") !== a.y > L.mid) other++
        }
        for (let x = 0; x <= w; x += 5) {
          const bar = { x: x - 2.5, y: L.mid - L.mark, w: 5, h: 2 * L.mark }
          for (const a of L.labels)
            if (overlapArea(bar, a) > 0) expect.fail(`${where}: a marker at x ${x} on label "${a.name}"`)
        }
        // the scrub cursor on (and around) every node, every 0.5 px: either the node is selected (the cursor is not drawn,
        // the selected ring touches no other node and no label) or the cursor's bar touches no node's marks
        for (const nd of L.nodes)
          for (let x = nd.x - 12; x <= nd.x + 12; x += 0.5) {
            const sel = cursorNode(L.nodes, x)
            if (sel) {
              const ring = {
                x: sel.x - TL_RING - 0.75,
                y: L.mid - TL_RING - 0.75,
                w: 2 * TL_RING + 1.5,
                h: 2 * TL_RING + 1.5,
              }
              for (const o of L.nodes)
                if (o !== sel && Math.abs(o.x - sel.x) < TL_RING + 0.75 + nodeExtent(o))
                  expect.fail(`${where}: the selected ring at ${sel.x} on the node at ${o.x}`)
              for (const a of L.labels)
                if (overlapArea(ring, a) > 0)
                  expect.fail(`${where}: the selected ring at ${sel.x} on label "${a.name}"`)
              cursorOn++
            } else
              for (const o of L.nodes)
                if (Math.abs(o.x - x) < nodeExtent(o) + TL_BAR_HALF)
                  expect.fail(`${where}: the cursor at ${x} drawn on the node at ${o.x}`)
          }
      }
    }
    expect(windows).toBe(1200)
    expect(cursorOn).toBeGreaterThan(1000)
    console.log(
      `timeline sweep: ${windows} windows, ${merged} merged nodes, ${other} labels in their other row; NOW bar and scrub cursor checked every 5 px in each, the cursor on a node ${cursorOn} times`,
    )
  }, 120_000)
})
