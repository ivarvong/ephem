// The mission timeline's model (lib/timeline.ts timelineLayout; components/home/Timeline.tsx draws it) and time scrubbing:
// drag (or tap, or the arrow keys on) the timeline once the browser computes; LIVE or Escape returns. A horizontal drag moves
// the sky through today; a vertical one scrolls the page (touch-action: pan-y). Each pointer move only sets the instant; one
// frame (requestAnimationFrame) computes the position, draws the chart and patches the readouts.
import { scrubOffset, tlTime as timeAt } from "../../lib/timeline.ts"
import { startRum } from "../rum.ts"
import { K, SC, baseNow, nowX, pose, scrub, scrubX, strip, tNow } from "./state.ts"
import { computeStrip, stripMarks } from "./model.ts"
import { dayAt, fetchBlocks, isMissingBlock } from "./compute.ts"
import { goLive, tick } from "./tick.ts"

let svg: SVGSVGElement | null = null
export const setStripSvg = (el: SVGSVGElement | null) => {
  svg = el
}

/** A local day the page has not got yet, computed here once the browser has taken over (a missing block is fetched). */
const dayFor = (date: string) => {
  if (!K.ready) return undefined
  try {
    return dayAt(date)
  } catch (e) {
    if (isMissingBlock(e)) void fetchBlocks([e.block]).then(drawStrip)
    return undefined
  }
}
/** Lay the timeline out again (new data, a new minute, a resize) at its measured width (model.ts computeStrip). */
export const drawStrip = () => {
  strip.value = computeStrip(svg?.getBoundingClientRect().width || strip.peek()?.w || 1000, baseNow(), tNow(), dayFor)
  drawStripNow()
}
/** The NOW marker: moved only when it moves a visible half pixel (every few minutes); the scrub cursor at the scrubbed instant. */
export const drawStripNow = () => {
  const s = strip.peek()
  if (!s) return
  const b = baseNow()
  if (Math.abs(b - s.anchor) >= 60e3) {
    drawStrip()
    return
  }
  const mk = stripMarks(s, b, tNow(), scrub.peek() != null)
  nowX.value = mk.now
  scrubX.value = mk.scrub
}

// ---------- scrubbing ----------
let simQ = false
const tlTime = (cx: number) => {
  const s = strip.peek()!,
    r = svg!.getBoundingClientRect()
  return timeAt(s.s0, s.span, s.w, ((cx - r.left) * s.w) / r.width)
}
const simFrame = () => {
  simQ = false
  const t0 = performance.now()
  tick(true)
  const c = SC.cur
  if (c?.on) {
    const d = performance.now() - t0
    c.n++
    c.sum += d
    if (d > c.max) c.max = d
  }
}
export const scrubTo = (t: number) => {
  const s = strip.peek()
  if (!K.ready || !s) return
  scrub.value = scrubOffset(s.s0, s.span, t, baseNow())
  if (!simQ) {
    simQ = true
    requestAnimationFrame(simFrame)
  }
}
const guideLive = (on: boolean) => document.getElementById("guide")?.setAttribute("aria-live", on ? "polite" : "off")

export const onStripDown = (e: PointerEvent) => {
  if (!K.ready || !strip.peek() || pose.peek() || (e.pointerType === "mouse" && e.button !== 0)) return
  SC.cur = { id: e.pointerId, x: e.clientX, y: e.clientY, on: false, t0: performance.now(), n: 0, sum: 0, max: 0 }
  if (e.pointerType === "mouse") e.preventDefault() // no text selection
}
export const onStripMove = (e: PointerEvent) => {
  const c = SC.cur
  if (!c || e.pointerId !== c.id) return
  if (!c.on) {
    const dx = e.clientX - c.x,
      dy = e.clientY - c.y
    if (Math.abs(dx) < 4 || Math.abs(dx) < Math.abs(dy)) return
    c.on = true
    try {
      svg?.setPointerCapture(e.pointerId)
    } catch {
      /* capture is a nicety */
    }
    guideLive(false)
  }
  scrubTo(tlTime(e.clientX))
}
export const onStripEnd = (e: PointerEvent | null) => {
  const c = SC.cur
  if (!c || (e && e.pointerId !== c.id)) return
  SC.cur = null
  if (!c.on && e && e.type === "pointerup") scrubTo(tlTime(e.clientX)) // a tap: jump there
  guideLive(true)
  if (c.on) {
    K.frames = { n: c.n, mean: c.n ? c.sum / c.n : 0, max: c.max }
    startRum().interaction("scrub", c.t0, performance.now(), "frames " + c.n + " max " + c.max.toFixed(1))
  }
  const sc = scrub.peek()
  if (sc != null && Math.abs(sc) < 60e3) goLive() // let go within a minute of now: live
}
export const onStripCancel = (e: PointerEvent) => {
  if (SC.cur && !SC.cur.on) SC.cur = null
  else onStripEnd(e)
}
export const onStripKey = (e: KeyboardEvent) => {
  if (!K.ready || !strip.peek()) return
  const stepMs = (e.shiftKey ? 60 : 10) * 60e3
  if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
    scrubTo(tNow() + (e.key === "ArrowLeft" ? -stepMs : stepMs))
    e.preventDefault()
  } else if (e.key === "Escape" || e.key === "Home") {
    goLive()
    e.preventDefault()
  }
}
