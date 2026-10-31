// The homepage's boot against an early tap, measured: the longest main-thread task in the first seconds (Long Tasks API) and
// the input delay of a real tap (CDP Input, through the browser's input pipeline) at data drawn + N ms (Event Timing
// first-input: processingStart − startTime, as INP counts it), in headless Chrome over our CDP client, emulated iPhone,
// Fast 3G, CPU 4×. Data drawn is the browser's Element Timing of the server's frame (`elementtiming="ephem-data"`).
// The tap is on the timeline (#tl): "handled" = the tap scrubbed (scrubbing starts once the browser computes, ephem:core).
// --trace adds, per run, the renderer main thread's tasks (CDP Tracing, devtools.timeline) from 150 ms before the tap's
// dispatch (EventDispatch pointerdown) to it: what the tap waited behind.
//   node --experimental-strip-types scripts/obs/boot-input.ts <url> [--runs 3] [--mode cold|warm] [--after 100] [--net fast3g] [--cpu 4] [--trace]
import { launch } from "./cdp/cdp.ts"
import * as P from "./cdp/page.ts"

const argv = process.argv.slice(2)
const opt = (k: string, d: string) => {
  const i = argv.indexOf(`--${k}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1]! : d
}
const target = argv.find((a) => /^https?:/.test(a)) ?? "http://127.0.0.1:8787/"
const runs = Number(opt("runs", "3")),
  mode = opt("mode", "cold") as "cold" | "warm",
  after = Number(opt("after", "100"))
const tracing = argv.includes("--trace")
const net = P.NETS[opt("net", "fast3g")] ?? null,
  cpu = Number(opt("cpu", "4")),
  device = P.DEVICES.iphone!
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
// Recorded by the browser only: long tasks, the Element Timing entry, the first input. Nothing here is inferred.
const PROBE = `window.__bi = { lt: [], et: null, fi: null };
new PerformanceObserver(l => { for (const e of l.getEntries()) __bi.lt.push([e.startTime, e.duration]) }).observe({ type: "longtask", buffered: true });
new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.identifier === "ephem-data" && __bi.et == null) __bi.et = e.renderTime || e.startTime }).observe({ type: "element", buffered: true });
new PerformanceObserver(l => { for (const e of l.getEntries()) __bi.fi = { name: e.name, start: e.startTime, delay: e.processingStart - e.startTime, duration: e.duration } }).observe({ type: "first-input", buffered: true });`

/** The main thread's top-level tasks (≥ 1 ms) in the 150 ms before the tap's dispatch, each with its largest child events
 *  (ms relative to the dispatch; recorded trace events only). */
const beforeTap = (ev: P.TraceEvent[]) => {
  const main = ev.find((e) => e.ph === "M" && e.name === "thread_name" && e.args?.name === "CrRendererMain")
  if (!main) return { error: "no CrRendererMain in the trace" }
  const on = ev.filter((e) => e.pid === main.pid && e.tid === main.tid && e.ph === "X" && e.dur != null)
  const disp = on.find((e) => e.name === "EventDispatch" && e.args?.data?.type === "pointerdown")
  if (!disp) return { error: "no pointerdown dispatch in the trace" }
  const tasks = on.filter(
    (e) => e.name === "RunTask" && e.ts + e.dur! > disp.ts - 150e3 && e.ts <= disp.ts && e.dur! >= 1e3,
  )
  return tasks.map((t) => {
    const kids = on
      .filter((e) => e !== t && e.ts >= t.ts && e.ts + e.dur! <= t.ts + t.dur! && e.name !== "RunTask" && e.dur! >= 1e3)
      .toSorted((a, z) => z.dur! - a.dur!)
      .slice(0, 4)
      .map(
        (e) =>
          `${e.name}${e.args?.data?.url ? " " + String(e.args.data.url).split("/").pop() : ""}${e.args?.data?.type ? " " + e.args.data.type : ""} ${(e.dur! / 1e3).toFixed(1)}`,
      )
    return { at: +((t.ts - disp.ts) / 1e3).toFixed(1), ms: +(t.dur! / 1e3).toFixed(1), kids }
  })
}

const b = await launch({ headless: true })
const out: unknown[] = []
try {
  const s = await b.newPage()
  await s.send("Page.enable")
  await s.send("Runtime.enable")
  await P.emulate(s, device)
  // where the timeline is (the layout is the server's; one unthrottled load finds it, and warms the cache for --mode warm)
  await P.navigate(s, target)
  await P.waitForFn(s, `window.__compute && window.__compute.ready`, 30_000)
  const tl = await P.evaluate<{ x: number; y: number }>(
    s,
    `(() => { const r = document.getElementById("tl").getBoundingClientRect(); return { x: r.left + r.width * 0.7, y: r.top + r.height / 2 } })()`,
  )
  if (tl.y > device.height)
    throw new Error("the timeline is below the fold at " + device.height + " px: the tap would need a scroll")
  await s.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE })
  // The tap is scheduled on the harness clock from the navigation, not by polling the page (a poll waits behind the very task
  // being measured): the first run (not reported) finds data drawn, each run then corrects by the last run's recorded error.
  // The recorded offset (tapAfterData, from the Event Timing and Element Timing entries) is what is reported.
  let aim = 0,
    corr = 0
  for (let i = 0; i <= runs; i++) {
    await s.send("Page.navigate", { url: "about:blank" })
    await P.cache(s, mode, new URL(target).origin)
    await P.throttle(s, net, cpu)
    if (tracing && i > 0) await P.traceStart(s)
    const t0 = Date.now()
    await s.send("Page.navigate", { url: target })
    if (i > 0) {
      await sleep(Math.max(0, t0 + aim + corr - Date.now()))
      await s.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [tl] })
      await s.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
    }
    await sleep(4000)
    const r = await P.evaluate<any>(
      s,
      `({ ...__bi, handled: document.getElementById("golive").hidden === false, marks: performance.getEntriesByType("mark").filter(m => m.name.startsWith("ephem:")).map(m => [m.name, Math.round(m.startTime)]) })`,
    )
    await P.throttle(s, null, 1)
    const waited = tracing && i > 0 ? beforeTap(await P.traceEnd(s)) : undefined
    const lt = (r.lt as Array<[number, number]>).filter(([t]) => t < 6000)
    const row = {
      run: i,
      mode,
      dataDrawn: Math.round(r.et),
      tap: r.fi ? Math.round(r.fi.start) : null,
      tapAfterData: r.fi ? Math.round(r.fi.start - r.et) : null,
      inputDelay: r.fi ? +r.fi.delay.toFixed(1) : null,
      inputDuration: r.fi?.duration ?? null,
      firstInput: r.fi?.name ?? null,
      handled: r.handled,
      longest: lt.length ? Math.round(Math.max(...lt.map((x) => x[1]))) : 0,
      longTasks: lt.map(([t, d]) => [Math.round(t), Math.round(d)]),
      marks: r.marks,
      ...(waited ? { waited } : {}),
    }
    if (i === 0) {
      aim = row.dataDrawn + after
      continue
    } // calibration
    if (row.tapAfterData != null) corr += after - row.tapAfterData
    out.push(row)
    console.error(JSON.stringify(row))
  }
} finally {
  await b.close()
}
console.log(JSON.stringify(out, null, 1))
