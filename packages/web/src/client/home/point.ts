// Pointing ("Point phone"): only on a tap; iOS asks permission from that tap; silently absent without a compass. And the guide
// line under the countdown: the aim while pointing, the scrubbed instant while not live.
import { aimShort, aimText, poseFrom, type Orientation } from "../../lib/pose.ts"
import { altOf, offText } from "../../lib/words.ts"
import { fmt, hms, localDate } from "../../lib/time.ts"
import { S, baseNow, center, decl, guideText, loc, pointing, pos, pose, scrub } from "./state.ts"
import { defaultCenter } from "./data.ts"
import { measureCtl } from "./sky.ts"
import { goLive } from "./tick.ts"

/** The aim on the guide line, from the live answer and the phone's pose. */
export const aimUpdate = () => {
  const ps = pose.peek(),
    p = pos.peek()
  if (!ps || !p || scrub.peek() != null) return
  const bs = (
    [
      ["Sun", p.sun],
      ["Moon", p.moon],
    ] as const
  ).map(([n, b]) => [n, { az: b.azimuth, alt: altOf(b) }] as const)
  const text = bs.map(([n, b]) => aimShort(n, b, ps)).join("   "),
    label = bs.map(([n, b]) => aimText(n, b, ps)).join(". ")
  const cur = guideText.peek()
  if (!cur || cur.text !== text || cur.label !== label) guideText.value = { text, label, sim: false }
}

/** Not live: the scrubbed instant and its offset from now, "NOT LIVE · SUN 1 NOV 02:49:49 · IN 17 H 53 MIN". */
export const simGuide = (t: number) => {
  const sc = scrub.peek(),
    tz = loc.peek().tz
  if (sc != null) {
    const text =
      "Not live · " +
      (localDate(t, tz) !== localDate(baseNow(), tz)
        ? fmt(tz, { weekday: "short", day: "numeric", month: "short" }).format(new Date(t)).replace(",", "") + " "
        : "") +
      hms(t, tz) +
      " · " +
      offText(sc)
    if (guideText.peek()?.text !== text) guideText.value = { text, label: null, sim: true }
  } else if (guideText.peek()?.sim) guideText.value = pose.peek() ? { text: "", label: null, sim: false } : null
}

let frameQueued = false
const orientEv = () => ("ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation")
const onOrient = (e: Event) => {
  const ps = poseFrom(e as DeviceOrientationEvent & Orientation, decl.peek())
  if (!ps) return
  pose.value = ps
  if (!frameQueued) {
    frameQueued = true
    requestAnimationFrame(() => {
      frameQueued = false
      const cur = pose.peek()
      if (cur) {
        center.value = cur.az
        aimUpdate()
      }
    })
  }
}
export const pointStop = () => {
  removeEventListener(orientEv(), onOrient)
  pose.value = null
  guideText.value = null
  pointing.value = "off"
  const p = pos.peek()
  if (p && !S.userPanned) center.value = defaultCenter(p)
  queueMicrotask(measureCtl)
}
const pointStart = () => {
  goLive()
  addEventListener(orientEv(), onOrient)
  pointing.value = "on"
  guideText.value = { text: "Hold the phone upright and point it at the sky…", label: null, sim: false }
  setTimeout(() => {
    if (!pose.peek() && pointing.peek() === "on") {
      pointStop()
      pointing.value = "hidden"
      queueMicrotask(measureCtl)
    }
  }, 3000) // no compass: quietly gone
}
export const onPointClick = () => {
  if (pointing.peek() === "on") {
    pointStop()
    return
  }
  const D = window.DeviceOrientationEvent as
    (typeof DeviceOrientationEvent & { requestPermission?: () => Promise<string> }) | undefined
  if (D && typeof D.requestPermission === "function")
    D.requestPermission().then(
      (s) => {
        if (s === "granted") pointStart()
        else pointing.value = "hidden"
      },
      () => {
        pointing.value = "hidden"
      },
    )
  else pointStart()
}
/** The button shows on phones with an orientation API. */
export const initPointing = () => {
  pointing.value = window.DeviceOrientationEvent && matchMedia("(pointer: coarse)").matches ? "off" : "hidden"
  queueMicrotask(measureCtl)
}
