// Time scrubbing on the homepage, measured: a touch (or mouse) drag across the timeline at ~60 Hz, with CPU throttling, in
// headless Chrome over our CDP client. Records (1) the page's own per-frame work (window.__compute.frames: compute + draw +
// readouts, performance.now() around each scrub frame), (2) frame-to-frame intervals of requestAnimationFrame during the drag
// (a harness-only sampler, injected for the drag and removed after), (3) the vertical-swipe check (a vertical drag on the
// timeline must scroll the page and not scrub), and screenshots mid-scrub and after LIVE.
//   node --experimental-strip-types scripts/obs/scrub.ts <url> [--device iphone|desktop] [--cpu 4] [--out dir] [--name base]
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { launch } from "./cdp/cdp.ts"
import * as P from "./cdp/page.ts"

const argv = process.argv.slice(2)
const opt = (k: string, d: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] ? argv[i + 1]! : d }
const target = argv.find(a => /^https?:/.test(a)) ?? "http://127.0.0.1:8787/?lat=40.7128&lon=-74.006&tz=America/New_York"
const device = P.DEVICES[opt("device", "iphone")]!, cpu = Number(opt("cpu", "4")), out = opt("out", "scrub-out"), name = opt("name", `scrub-${opt("device", "iphone")}-cpu${cpu}`)
mkdirSync(out, { recursive: true })
const b = await launch({ headless: true })
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
try {
  const s = await b.newPage(); await s.send("Page.enable"); await s.send("Runtime.enable")
  await P.emulate(s, device)
  await P.navigate(s, target)
  await P.waitForFn(s, `window.__compute && window.__compute.ready`, 30_000)
  await P.throttle(s, null, cpu)
  await P.evaluate(s, `document.getElementById("tl").scrollIntoView({ block: "center" })`); await sleep(300)
  const r = await P.evaluate<{ x: number; y: number; w: number; h: number }>(s, `(() => { const r = document.getElementById("tl").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)
  const y = r.y + r.h / 2, x0 = r.x + r.w * 0.15, x1 = r.x + r.w * 0.85
  // a vertical swipe on the strip: the page scrolls, nothing scrubs
  const sy0 = await P.evaluate<number>(s, "scrollY")
  await P.drag(s, r.x + r.w / 2, y, 0, -120, device.touch, 10); await sleep(400)
  const vertical = { scrolledPx: (await P.evaluate<number>(s, "scrollY")) - sy0, scrubbed: await P.evaluate<boolean>(s, `document.getElementById("golive").hidden === false`) }
  await P.evaluate(s, `scrollTo(0, ${sy0})`); await sleep(300)
  // the drag: 90 moves ~16 ms apart, with a rAF sampler running only for its duration
  await P.evaluate(s, `window.__rafT = []; (function f(t) { window.__rafT.push(t); if (window.__rafT.length < 2000 && !window.__rafStop) requestAnimationFrame(f); })(performance.now())`)
  const steps = 90, at = (i: number) => ({ x: x0 + (x1 - x0) * i / steps, y })
  const shots: string[] = []
  if (device.touch) await s.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at(0)] })
  else await s.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at(0), button: "left", buttons: 1, clickCount: 1 })
  const t0 = Date.now()
  for (let i = 1; i <= steps; i++) {
    if (device.touch) await s.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [at(i)] })
    else await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at(i), button: "left", buttons: 1 })
    await sleep(16)
    if (i === 45) { await P.evaluate(s, "scrollTo(0, 0)"); shots.push(await P.screenshot(s, join(out, `${name}-mid.png`))); await P.evaluate(s, `document.getElementById("tl").scrollIntoView({ block: "center" })`) }
  }
  const dragMs = Date.now() - t0
  if (device.touch) await s.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  else await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at(steps), button: "left", buttons: 0, clickCount: 1 })
  await sleep(300)
  const raf = await P.evaluate<number[]>(s, `(window.__rafStop = true, window.__rafT)`)
  const iv = raf.slice(1).map((t, i) => t - raf[i]!).toSorted((a, z) => a - z), q = (p: number) => +(iv[Math.min(iv.length - 1, Math.floor(p * iv.length))] ?? 0).toFixed(1)
  const page = await P.evaluate<any>(s, `({ frames: __compute.frames, scrubbed: document.getElementById("golive").hidden === false, guide: document.getElementById("guide").textContent, live: document.getElementById("liveT").textContent })`)
  await P.evaluate(s, "scrollTo(0, 0)"); await sleep(200)
  shots.push(await P.screenshot(s, join(out, `${name}-end.png`)))
  await P.tap(s, "#golive", device.touch); await sleep(1200)
  const back = await P.evaluate<any>(s, `({ scrubbed: document.getElementById("golive").hidden === false, live: document.getElementById("liveT").textContent, guideHidden: document.getElementById("guide").hidden })`)
  shots.push(await P.screenshot(s, join(out, `${name}-live.png`)))
  console.log(JSON.stringify({ device: device.name, cpu, moves: steps, dragMs, vertical, frames: page.frames, raf: { n: iv.length, p50: q(0.5), p95: q(0.95), max: q(1), over20ms: iv.filter(x => x > 20).length }, afterDrag: { scrubbed: page.scrubbed, guide: page.guide, live: page.live }, afterLive: back, shots }, null, 1))
} finally { await b.close() }
