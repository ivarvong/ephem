// Page helpers on a CDP Session (scripts/obs/cdp/cdp.ts): navigation with load / network-idle waits, device emulation,
// network + CPU throttling, cache control, input (tap, drag, key, type), screenshots, Tracing with the devtools.timeline
// categories, and a Network recorder with full timing and response headers.
import { writeFileSync } from "node:fs"
import type { Session } from "./cdp.ts"

// ---------- devices, networks ----------
export interface Device { name: string; width: number; height: number; dpr: number; mobile: boolean; touch: boolean; ua?: string }
export const DEVICES: Record<string, Device> = {
  iphone: { name: "iPhone 390×844 @3x", width: 390, height: 844, dpr: 3, mobile: true, touch: true,
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" },
  desktop: { name: "Desktop 1440×900 @2x", width: 1440, height: 900, dpr: 2, mobile: false, touch: false },
}
/** DevTools' presets (bytes/s; latency ms). */
export interface Net { name: string; latency: number; down: number; up: number }
export const NETS: Record<string, Net | null> = {
  fast3g: { name: "Fast 3G (562.5 ms, 1.44 Mbps)", latency: 562.5, down: (1.6 * 1024 * 1024 / 8) * 0.9, up: (750 * 1024 / 8) * 0.9 },
  "4g": { name: "Fast 4G (165 ms, 8.1 Mbps)", latency: 165, down: (9 * 1024 * 1024 / 8) * 0.9, up: (1.5 * 1024 * 1024 / 8) * 0.9 },
  none: null,
}

export async function emulate(s: Session, d: Device) {
  await s.send("Emulation.setDeviceMetricsOverride", { width: d.width, height: d.height, deviceScaleFactor: d.dpr, mobile: d.mobile })
  await s.send("Emulation.setTouchEmulationEnabled", { enabled: d.touch, maxTouchPoints: d.touch ? 5 : 1 })
  if (d.ua) await s.send("Emulation.setUserAgentOverride", { userAgent: d.ua, platform: "iPhone" })
}
export async function throttle(s: Session, net: Net | null, cpu = 1) {
  await s.send("Network.emulateNetworkConditions", net
    ? { offline: false, latency: net.latency, downloadThroughput: net.down, uploadThroughput: net.up }
    : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await s.send("Emulation.setCPUThrottlingRate", { rate: cpu })
}
/** Cold: empty HTTP cache and origin storage, cache disabled. Warm: cache on. */
export async function cache(s: Session, mode: "cold" | "warm", origin?: string) {
  if (mode === "cold") {
    await s.send("Network.clearBrowserCache")
    if (origin) await s.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" })
  }
  await s.send("Network.setCacheDisabled", { cacheDisabled: mode === "cold" })
}

// ---------- navigation ----------
/** Navigate and wait for the load event, or for network idle (no request in flight for `idleMs`, after load). */
export async function navigate(s: Session, url: string, o: { until?: "load" | "networkidle"; idleMs?: number; timeoutMs?: number } = {}) {
  const timeout = o.timeoutMs ?? 60_000
  const loaded = s.waitFor("Page.loadEventFired", undefined, timeout)
  const r = await s.send("Page.navigate", { url })
  if (r.errorText) throw new Error(`navigate ${url}: ${r.errorText}`)
  await loaded
  if (o.until === "networkidle") await networkIdle(s, o.idleMs ?? 500, timeout)
  return r
}
export function networkIdle(s: Session, idleMs: number, timeoutMs: number) {
  const inflight = new Set<string>()
  return new Promise<void>((resolve, reject) => {
    let t: ReturnType<typeof setTimeout> | undefined
    const arm = () => { clearTimeout(t); if (inflight.size === 0) t = setTimeout(done, idleMs) }
    const offs = [
      s.on("Network.requestWillBeSent", e => { inflight.add(e.requestId); arm() }),
      s.on("Network.loadingFinished", e => { inflight.delete(e.requestId); arm() }),
      s.on("Network.loadingFailed", e => { inflight.delete(e.requestId); arm() }),
    ]
    const dead = setTimeout(() => { offs.forEach(f => f()); clearTimeout(t); reject(new Error(`network idle: timed out (${inflight.size} in flight)`)) }, timeoutMs)
    function done() { offs.forEach(f => f()); clearTimeout(dead); resolve() }
    arm()
  })
}
export async function evaluate<T = unknown>(s: Session, expression: string): Promise<T> {
  const r = await s.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`)
  return r.result.value as T
}
export async function waitForFn(s: Session, expression: string, timeoutMs = 30_000, everyMs = 100) {
  for (const t0 = Date.now(); Date.now() - t0 < timeoutMs; await new Promise(r => setTimeout(r, everyMs)))
    if (await evaluate<boolean>(s, `!!(${expression})`)) return
  throw new Error(`waitFor ${expression}: timed out after ${timeoutMs} ms`)
}

// ---------- input ----------
export async function center(s: Session, selector: string): Promise<{ x: number; y: number }> {
  const r = await evaluate<{ x: number; y: number } | null>(s, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null;
    e.scrollIntoView({ block: "nearest" }); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 } })()`)
  if (!r) throw new Error(`no element ${selector}`)
  return r
}
/** Touch tap (touch devices) or mouse click at an element's centre. */
export async function tap(s: Session, selector: string, touch: boolean) {
  const { x, y } = await center(s, selector)
  if (touch) {
    await s.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] })
    await s.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  } else {
    await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y })
    await s.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 })
    await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 })
  }
}
/** Drag from (x0, y0) by (dx, dy) in `steps` moves, ~16 ms apart. */
export async function drag(s: Session, x0: number, y0: number, dx: number, dy: number, touch: boolean, steps = 12) {
  const at = (i: number) => ({ x: x0 + dx * i / steps, y: y0 + dy * i / steps })
  const pause = () => new Promise(r => setTimeout(r, 16))
  if (touch) {
    await s.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [at(0)] })
    for (let i = 1; i <= steps; i++) { await s.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [at(i)] }); await pause() }
    await s.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] })
  } else {
    await s.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at(0), button: "left", buttons: 1, clickCount: 1 })
    for (let i = 1; i <= steps; i++) { await s.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...at(i), button: "left", buttons: 1 }); await pause() }
    await s.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at(steps), button: "left", buttons: 0, clickCount: 1 })
  }
}
const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" }, Backspace: { code: "Backspace", keyCode: 8 }, Escape: { code: "Escape", keyCode: 27 },
  Tab: { code: "Tab", keyCode: 9 }, ArrowLeft: { code: "ArrowLeft", keyCode: 37 }, ArrowRight: { code: "ArrowRight", keyCode: 39 },
  F1: { code: "F1", keyCode: 112 }, F2: { code: "F2", keyCode: 113 },
}
export async function key(s: Session, k: string) {
  const d = KEYS[k] ?? { code: k.length === 1 ? `Key${k.toUpperCase()}` : k, keyCode: k.toUpperCase().charCodeAt(0), text: k.length === 1 ? k : undefined }
  await s.send("Input.dispatchKeyEvent", { type: d.text ? "keyDown" : "rawKeyDown", key: k, code: d.code, windowsVirtualKeyCode: d.keyCode, ...(d.text ? { text: d.text } : {}) })
  await s.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: d.code, windowsVirtualKeyCode: d.keyCode })
}
export async function type(s: Session, text: string) { for (const ch of text) await key(s, ch) }

export async function screenshot(s: Session, file: string) {
  const { data } = await s.send("Page.captureScreenshot", { format: "png" })
  writeFileSync(file, Buffer.from(data, "base64")); return file
}

// ---------- tracing ----------
/** devtools.timeline (parse, script eval, style/layout, paint, long tasks), user timing, loading (FCP/LCP), v8 compile. */
export const TIMELINE = ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame",
  "blink.user_timing", "loading", "latencyInfo", "v8.execute", "disabled-by-default-v8.compile", "blink", "toplevel", "__metadata"]
export interface TraceEvent { name: string; cat: string; ph: string; ts: number; dur?: number; pid: number; tid: number; args?: any; s?: string; id?: string }
export async function traceStart(s: Session, categories = TIMELINE) {
  await s.send("Tracing.start", { transferMode: "ReturnAsStream", traceConfig: { includedCategories: categories, excludedCategories: ["*"] } })
}
export async function traceEnd(s: Session): Promise<TraceEvent[]> {
  const complete = s.waitFor<{ stream: string }>("Tracing.tracingComplete", undefined, 120_000)
  await s.send("Tracing.end")
  const { stream } = await complete
  let buf = ""
  for (;;) {
    const r = await s.send("IO.read", { handle: stream, size: 1 << 20 }, 60_000)
    buf += r.base64Encoded ? Buffer.from(r.data, "base64").toString("utf8") : r.data
    if (r.eof) break
  }
  await s.send("IO.close", { handle: stream })
  const j = JSON.parse(buf) as { traceEvents?: TraceEvent[] } | TraceEvent[]
  return Array.isArray(j) ? j : j.traceEvents ?? []
}

// ---------- network ----------
export interface Timing { requestTime: number; dnsStart: number; dnsEnd: number; connectStart: number; connectEnd: number; sslStart: number; sslEnd: number; sendStart: number; sendEnd: number; receiveHeadersEnd: number }
export interface Req {
  id: string; url: string; method: string; type?: string; initiator?: string
  start: number; wallTime: number          // monotonic s (trace timebase / 1e6) and epoch s at requestWillBeSent
  status?: number; protocol?: string; mime?: string; fromCache?: "disk" | "memory" | "prefetch" | "sw" | undefined
  timing?: Timing; end?: number; encoded?: number; failed?: string
  /** documents only: every Network.dataReceived as [monotonic s, decoded bytes]: when each part of the body arrived */
  chunks?: Array<[number, number]>
  headers: Record<string, string>; reqHeaders: Record<string, string>
}
const lower = (h: Record<string, string> = {}) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]))
/** Records every request of the session (call before navigating). */
export async function recordNetwork(s: Session) {
  const reqs = new Map<string, Req>(), order: Req[] = []
  s.on("Network.requestWillBeSent", e => {
    if (e.redirectResponse && reqs.has(e.requestId)) { const old = reqs.get(e.requestId)!; old.id += ":redirect"; old.end = e.timestamp; reqs.delete(e.requestId) }
    const r: Req = { id: e.requestId, url: e.request.url, method: e.request.method, type: e.type, initiator: e.initiator?.type, start: e.timestamp, wallTime: e.wallTime, headers: {}, reqHeaders: lower(e.request.headers) }
    reqs.set(e.requestId, r); order.push(r)
  })
  s.on("Network.requestWillBeSentExtraInfo", e => { const r = reqs.get(e.requestId); if (r) Object.assign(r.reqHeaders, lower(e.headers)) })
  s.on("Network.responseReceived", e => {
    const r = reqs.get(e.requestId); if (!r) return
    const p = e.response
    r.status = p.status; r.protocol = p.protocol; r.mime = p.mimeType; r.timing = p.timing; r.type = e.type ?? r.type
    r.fromCache = p.fromPrefetchCache ? "prefetch" : p.fromServiceWorker ? "sw" : p.fromDiskCache ? "disk" : r.fromCache
    Object.assign(r.headers, lower(p.headers))
  })
  s.on("Network.responseReceivedExtraInfo", e => { const r = reqs.get(e.requestId); if (r) Object.assign(r.headers, lower(e.headers)) })
  s.on("Network.requestServedFromCache", e => { const r = reqs.get(e.requestId); if (r) r.fromCache = "memory" })
  s.on("Network.dataReceived", e => { const r = reqs.get(e.requestId); if (r && r.type === "Document") (r.chunks ??= []).push([e.timestamp, e.dataLength]) })
  s.on("Network.loadingFinished", e => { const r = reqs.get(e.requestId); if (r) { r.end = e.timestamp; r.encoded = e.encodedDataLength } })
  s.on("Network.loadingFailed", e => { const r = reqs.get(e.requestId); if (r) { r.end = e.timestamp; r.failed = e.errorText } })
  await s.send("Network.enable", { maxPostDataSize: 0 })
  return order
}
