// A tiny Chrome DevTools Protocol client: no deps (Node 22+ global WebSocket and fetch), run with --experimental-strip-types.
//   const b = await launch({ headless: true }); const p = await b.newPage(); await p.send("Page.navigate", { url })
//   p.on("Network.responseReceived", e => …); await p.waitFor("Page.loadEventFired"); await b.close()
// One browser WebSocket (from /json/version); pages are flattened sessions (Target.attachToTarget { flatten: true }), so every
// message carries its sessionId and one socket multiplexes them all. Every command has a timeout; close() (also on exit,
// SIGINT, SIGTERM and an uncaught error) closes the browser, kills the process and removes the temp profile.
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** The commands this repo uses, typed; any other method still works with loose params/results. */
export interface Commands {
  "Target.createTarget": [{ url: string; newWindow?: boolean }, { targetId: string }]
  "Target.attachToTarget": [{ targetId: string; flatten: true }, { sessionId: string }]
  "Target.closeTarget": [{ targetId: string }, { success: boolean }]
  "Browser.getVersion": [Record<string, never>, { product: string; userAgent: string; protocolVersion: string }]
  "Browser.close": [Record<string, never>, Record<string, never>]
  "Page.navigate": [{ url: string }, { frameId: string; loaderId?: string; errorText?: string }]
  "Page.captureScreenshot": [{ format?: "png" | "jpeg"; quality?: number; captureBeyondViewport?: boolean }, { data: string }]
  "Runtime.evaluate": [{ expression: string; returnByValue?: boolean; awaitPromise?: boolean }, { result: { value?: unknown; description?: string }; exceptionDetails?: { text: string; exception?: { description?: string } } }]
  "Tracing.start": [{ transferMode?: "ReturnAsStream" | "ReportEvents"; traceConfig: { includedCategories: string[]; excludedCategories?: string[] } }, Record<string, never>]
  "Tracing.end": [Record<string, never>, Record<string, never>]
  "IO.read": [{ handle: string; size?: number }, { data: string; eof: boolean; base64Encoded?: boolean }]
  "IO.close": [{ handle: string }, Record<string, never>]
}
type Params<M extends string> = M extends keyof Commands ? Commands[M][0] : Record<string, unknown>
type Result<M extends string> = M extends keyof Commands ? Commands[M][1] : any
type Handler = (params: any) => void

export class CdpError extends Error {}

/** The browser socket: request ids, pending replies with timeouts, event listeners keyed by (sessionId, method). */
export class Connection {
  private id = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; method: string }>()
  private listeners = new Map<string, Set<Handler>>()
  closed = false
  private ws: WebSocket
  timeoutMs: number
  constructor(ws: WebSocket, timeoutMs = 30_000) {
    this.ws = ws; this.timeoutMs = timeoutMs
    ws.addEventListener("message", ev => this.onMessage(String(ev.data)))
    ws.addEventListener("close", () => this.fail(new CdpError("CDP socket closed")))
  }
  static async open(url: string, timeoutMs?: number): Promise<Connection> {
    const ws = new WebSocket(url)
    await new Promise<void>((res, rej) => { ws.addEventListener("open", () => res(), { once: true }); ws.addEventListener("error", () => rej(new CdpError(`cannot open ${url}`)), { once: true }) })
    return new Connection(ws, timeoutMs)
  }
  private onMessage(raw: string) {
    const m = JSON.parse(raw) as { id?: number; result?: unknown; error?: { message: string; data?: string }; method?: string; params?: unknown; sessionId?: string }
    if (m.id !== undefined) {
      const p = this.pending.get(m.id); if (!p) return
      this.pending.delete(m.id); clearTimeout(p.timer)
      if (m.error) p.reject(new CdpError(`${p.method}: ${m.error.message}${m.error.data ? ` (${m.error.data})` : ""}`)); else p.resolve(m.result)
      return
    }
    if (!m.method) return
    for (const k of [`${m.sessionId ?? ""}|${m.method}`, `${m.sessionId ?? ""}|*`]) for (const h of this.listeners.get(k) ?? []) {
      try { h(k.endsWith("|*") ? { method: m.method, params: m.params } : m.params) } catch (e) { console.error(`listener ${m.method}:`, e) }
    }
  }
  private fail(e: Error) {
    this.closed = true
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(e) }
    this.pending.clear()
  }
  send<M extends string>(method: M, params?: Params<M>, sessionId?: string, timeoutMs = this.timeoutMs): Promise<Result<M>> {
    if (this.closed) return Promise.reject(new CdpError(`${method}: connection closed`))
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new CdpError(`${method}: no reply in ${timeoutMs} ms`)) }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method })
      this.ws.send(JSON.stringify({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) }))
    })
  }
  /** Subscribe to an event ("*" = every event, handler gets { method, params }). Returns the unsubscribe function. */
  on(method: string, h: Handler, sessionId = ""): () => void {
    const k = `${sessionId}|${method}`; let s = this.listeners.get(k); if (!s) this.listeners.set(k, (s = new Set()))
    s.add(h); return () => { s!.delete(h) }
  }
  /** The next event `method` (matching `pred`), or a timeout error. */
  waitFor<T = any>(method: string, pred: (p: T) => boolean = () => true, timeoutMs = this.timeoutMs, sessionId = ""): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new CdpError(`waitFor ${method}: timed out after ${timeoutMs} ms`)) }, timeoutMs)
      const off = this.on(method, (p: T) => { if (pred(p)) { clearTimeout(timer); off(); resolve(p) } }, sessionId)
    })
  }
  close() { this.closed = true; try { this.ws.close() } catch { /* already closed */ } }
}

/** One page target over a flattened session on the browser connection. */
export class Session {
  readonly conn: Connection; readonly sessionId: string; readonly targetId: string
  constructor(conn: Connection, sessionId: string, targetId: string) { this.conn = conn; this.sessionId = sessionId; this.targetId = targetId }
  send<M extends string>(method: M, params?: Params<M>, timeoutMs?: number): Promise<Result<M>> { return this.conn.send(method, params, this.sessionId, timeoutMs) }
  on(method: string, h: Handler) { return this.conn.on(method, h, this.sessionId) }
  waitFor<T = any>(method: string, pred?: (p: T) => boolean, timeoutMs?: number) { return this.conn.waitFor<T>(method, pred, timeoutMs, this.sessionId) }
}

export interface LaunchOptions { headless?: boolean; chrome?: string; args?: string[]; timeoutMs?: number; verbose?: boolean }

const CHROMES = [process.env.CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter((x): x is string => !!x)

const freePort = () => new Promise<number>((res, rej) => {
  const s = createServer(); s.unref(); s.on("error", rej)
  s.listen(0, "127.0.0.1", () => { const a = s.address(); s.close(() => typeof a === "object" && a ? res(a.port) : rej(new Error("no port"))) })
})

export class Browser {
  private done = false
  readonly conn: Connection; readonly proc: ChildProcess; readonly profile: string; readonly version: { product: string; userAgent: string }
  private constructor(conn: Connection, proc: ChildProcess, profile: string, version: { product: string; userAgent: string }) {
    this.conn = conn; this.proc = proc; this.profile = profile; this.version = version
  }

  /** Launch Chrome with a temp profile and --remote-debugging-port, find the browser socket via /json/version, connect. */
  static async launch(o: LaunchOptions = {}): Promise<Browser> {
    const bin = o.chrome ?? CHROMES.find(p => existsSync(p))
    if (!bin) throw new CdpError(`no Chrome found (set CHROME); tried ${CHROMES.join(", ")}`)
    const profile = mkdtempSync(join(tmpdir(), "ephem-cdp-")), port = await freePort()
    const args = [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", "--disable-component-update", "--disable-sync", "--disable-extensions", "--mute-audio",
      "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
      ...(o.headless === false ? [] : ["--headless=new"]), ...(o.args ?? []), "about:blank"]
    const proc = spawn(bin, args, { stdio: ["ignore", "ignore", o.verbose ? "inherit" : "ignore"] })
    const rm = () => { try { rmSync(profile, { recursive: true, force: true }) } catch { /* best effort */ } }
    let ws: string | undefined
    for (const t0 = Date.now(); !ws && Date.now() - t0 < 15_000;) {
      if (proc.exitCode !== null) { rm(); throw new CdpError(`Chrome exited (${proc.exitCode}) before listening`) }
      try { ws = ((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl }
      catch { await new Promise(r => setTimeout(r, 100)) }
    }
    if (!ws) { proc.kill("SIGKILL"); rm(); throw new CdpError("Chrome never answered /json/version") }
    const conn = await Connection.open(ws, o.timeoutMs)
    const b = new Browser(conn, proc, profile, await conn.send("Browser.getVersion"))
    live.add(b); return b
  }

  /** A new tab, attached as a flattened session. */
  async newPage(url = "about:blank"): Promise<Session> {
    const { targetId } = await this.conn.send("Target.createTarget", { url })
    const { sessionId } = await this.conn.send("Target.attachToTarget", { targetId, flatten: true })
    return new Session(this.conn, sessionId, targetId)
  }

  /** Browser.close, then SIGKILL if it is still running after 3 s; the temp profile is removed either way. Idempotent. */
  async close(): Promise<void> {
    if (this.done) return; this.done = true; live.delete(this)
    const exited = new Promise<void>(r => { if (this.proc.exitCode !== null) r(); else this.proc.once("exit", () => r()) })
    try { await this.conn.send("Browser.close", {}, undefined, 3000) } catch { /* fall through to kill */ }
    this.conn.close()
    await Promise.race([exited, new Promise(r => setTimeout(r, 3000))])
    if (this.proc.exitCode === null) { this.proc.kill("SIGKILL"); await Promise.race([exited, new Promise(r => setTimeout(r, 2000))]) }
    try { rmSync(this.profile, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  /** Synchronous last resort (process exit): kill and remove the profile. */
  killSync() { if (this.done) return; this.done = true; try { this.proc.kill("SIGKILL") } catch { /* gone */ } try { rmSync(this.profile, { recursive: true, force: true }) } catch { /* best effort */ } }
}

// Teardown on every way out: no Chrome is ever left running.
const live = new Set<Browser>()
process.on("exit", () => { for (const b of live) b.killSync() })
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => { void Promise.all([...live].map(b => b.close())).finally(() => process.exit(130)) })
process.on("uncaughtException", e => { console.error(e); void Promise.all([...live].map(b => b.close())).finally(() => process.exit(1)) })
process.on("unhandledRejection", e => { console.error(e); void Promise.all([...live].map(b => b.close())).finally(() => process.exit(1)) })

export const launch = (o?: LaunchOptions) => Browser.launch(o)
