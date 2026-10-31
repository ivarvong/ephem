// The sky chart's browser side: its size and the corner buttons' rect (measured; the first frame used the server's nominal
// ones), panning (drag, ←/→), Recenter, and the harnesses' view (window.__sky). The chart itself is
// components/home/SkyChart.tsx: SVG, rendered on the server and hydrated, re-rendered when its inputs change (data, the
// clock, a resize, a pan, pointing). It draws nothing on a timer: no rAF loop.
import { effect } from "@preact/signals"
import { startRum } from "../rum.ts"
import { S, center, chartRev, ctlRect, pos, pose, recenterShown, skySize } from "./state.ts"
import { defaultCenter, skyDebug } from "./model.ts"
import { frame } from "../../components/home/SkyChart.tsx"

declare global {
  interface Window {
    __sky?: ReturnType<typeof skyDebug>
  }
}

let sky: HTMLElement | null = null,
  draws = 0,
  marked = false

/** Redraw the chart now (a new frame, the fonts). */
export const requestDraw = () => {
  chartRev.value++
}

/** Measure the chart's box and the corner buttons (a resize; a button shown or hidden). */
export const resize = () => {
  if (!sky) return
  const r = sky.getBoundingClientRect(),
    cs = getComputedStyle(sky),
    z = skySize.peek()
  const W = r.width,
    H = r.height,
    insetL = parseFloat(cs.paddingLeft) || 0,
    insetR = parseFloat(cs.paddingRight) || 0
  if (W !== z.W || H !== z.H || insetL !== z.insetL || insetR !== z.insetR) skySize.value = { W, H, insetL, insetR }
  measureCtl()
}
export const measureCtl = () => {
  const ce = document.getElementById("ctl")
  if (!ce || !sky) return
  const any = [...ce.querySelectorAll("button")].some((b) => !b.hidden),
    W = skySize.peek().W,
    cur = ctlRect.peek()
  const next = any ? { id: "ctl", x: W - ce.offsetWidth, y: 0, w: ce.offsetWidth, h: ce.offsetHeight } : null
  if (JSON.stringify(next) !== JSON.stringify(cur)) ctlRect.value = next
}

/** Pan; Recenter appears once you've looked away and restores the default frame. */
const panned = () => {
  S.userPanned = true
  recenterShown.value = true
}
export const recenter = () => {
  S.userPanned = false
  const p = pos.peek()
  if (p) center.value = defaultCenter(p)
  recenterShown.value = false
}

/** Wire the chart (once, after hydration). */
export const mountSky = (section: HTMLElement) => {
  sky = section
  let drag: { x: number; c: number | null; t0: number; moved: boolean } | null = null
  section.addEventListener("pointerdown", (e) => {
    if ((e.target as Element).closest("button")) return
    drag = { x: e.clientX, c: center.peek(), t0: performance.now(), moved: false }
  })
  addEventListener("pointermove", (e) => {
    if (!drag || center.peek() == null || pose.peek() || drag.c == null) return
    if (Math.abs(e.clientX - drag.x) < 3) return
    center.value = (drag.c - (e.clientX - drag.x) / (skySize.peek().W / 360) + 720) % 360
    drag.moved = true
    panned()
  })
  addEventListener("pointerup", () => {
    if (drag?.moved) startRum().interaction("drag", drag.t0, performance.now())
    drag = null
  })
  addEventListener("pointercancel", () => {
    drag = null
  })
  section.addEventListener("keydown", (e) => {
    const c = center.peek()
    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && c != null && (e.target as Element).id === "cv") {
      center.value = (c + (e.key === "ArrowLeft" ? -10 : 10) + 360) % 360
      panned()
      e.preventDefault()
    }
  })
  // the harnesses' view of every frame drawn, and the first frame with an answer drawn by this browser (journey.ts, RUM)
  effect(() => {
    const f = frame.value
    window.__sky = skyDebug(f, f.W, f.H, ++draws)
    if (f.p && !marked) {
      marked = true
      startRum().mark("first-sky-draw")
    }
  })
  resize()
}
