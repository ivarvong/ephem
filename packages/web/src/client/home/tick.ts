// The page's clock: once a second (on the second of the corrected clock), and on every scrub frame (frame = true: draw in this
// frame). Nothing runs while the tab is hidden; it catches up when shown.
import { batch } from "@preact/signals"
import { localDate } from "../../lib/time.ts"
import {
  K,
  S,
  SC,
  center,
  baseNow,
  baseTime,
  day,
  diagRev,
  guideText,
  loc,
  now as nowSig,
  pos,
  pose,
  scrub,
  tNow,
  tickRev,
} from "./state.ts"
import { loadDay, loadTomorrow, loadTrack } from "./data.ts"
import { computeAt } from "./compute.ts"
import { measureCtl } from "./sky.ts"
import { nextEvent, upcoming } from "./model.ts"
import { drawStripNow } from "./strip.ts"
import { simGuide } from "./point.ts"

export { nextEvent }
let lastGolive = false
export const tick = (frame = false) => {
  if (document.hidden && !frame) return
  const t = tNow(),
    sim = scrub.peek() != null
  if (K.ready) computeAt(t, !!SC.cur?.on)
  batch(() => {
    nowSig.value = t
    baseTime.value = baseNow()
    tickRev.value++
  })
  if (lastGolive !== sim) {
    lastGolive = sim
    queueMicrotask(measureCtl)
  } // the LIVE button is a hard rect in the label layout
  simGuide(t)
  const d = day.peek()
  if (!upcoming(t).length && d && !d.loading && S.tomorrowFor !== d.date) void loadTomorrow() // today has nothing left: only now is tomorrow's /v1/day needed
  if (d && localDate(t, loc.peek().tz) !== d.date) void loadDay()
  if (S.trackDay != null && Math.floor(t / 864e5) !== S.trackDay) void loadTrack() // a new UTC day: the next track window
  drawStripNow()
  if (!frame) diagIfOpen()
}
const diagIfOpen = () => {
  if ((document.getElementById("hood") as HTMLDetailsElement | null)?.open) diagRev.value++
}

/** Back to live (pointing and LIVE return; Escape). */
export const goLive = () => {
  if (scrub.peek() == null) return
  scrub.value = null
  if (pos.peek() && !S.userPanned && !pose.peek()) center.value = null // the default frame again, at now (setPos sets it)
  tick(true)
}

/** Start the second-aligned clock. */
export const startClock = () => {
  const every = () => {
    setTimeout(
      () => {
        tick()
        every()
      },
      1005 - (((tNow() % 1000) + 1000) % 1000),
    )
  }
  every()
  tick()
}
export { guideText }
