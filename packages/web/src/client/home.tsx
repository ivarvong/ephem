// The homepage's browser entry (a deferred module: it runs once the server's stream, first answers included, is parsed).
// It hydrates the server-rendered shell (components/home/Home.tsx), boots from the embedded answers (no API round trip for the
// first frame), then keeps the page live: a tick every second, the browser takeover (client/home/compute.ts), weather.
import { hydrate } from "preact"
import { batch, effect } from "@preact/signals"
import { clockOffset, localDate } from "../lib/time.ts"
import type { Day, Magnetic, Position, Track } from "../lib/types.ts"
import { ActionsContext, type Actions } from "../components/home/actions.ts"
import { Header, Home } from "../components/home/Home.tsx"
import { startRum } from "./rum.ts"
import {
  DAYS,
  K,
  S,
  center,
  curl,
  decl,
  env,
  loc,
  locNote,
  pos,
  pose,
  rawOpen,
  scrub,
  tNow,
  track,
  type Boot,
} from "./home/state.ts"
import { curlText, seedFrame } from "./home/frame.ts"
import { diag, embed, loadDay, loadPos, loadTrack, loadWx, q, setPos } from "./home/data.ts"
import { takeover } from "./home/compute.ts"
import { mountSky, recenter, requestDraw, resize } from "./home/sky.ts"
import {
  drawStrip,
  onStripCancel,
  onStripDown,
  onStripEnd,
  onStripKey,
  onStripMove,
  setStripSvg,
} from "./home/strip.ts"
import { goLive, startClock, tick } from "./home/tick.ts"
import { initPointing, onPointClick } from "./home/point.ts"
import { loadFonts } from "./fonts.ts"

if (import.meta.env.DEV) void import("../styles/app.css") // dev: Vite injects the stylesheet (with HMR); the build inlines it

declare global {
  interface Window {
    __compute?: typeof K
  }
}

const boot = JSON.parse(document.getElementById("ephem-boot")?.textContent ?? "null") as Boot
// The clock is Cloudflare's, not the device's: sky.now is the server's clock as it wrote this page's head, which arrived between
// requestStart and responseStart (Navigation Timing).
const clk = clockOffset(
  boot.sky.now,
  performance.getEntriesByType?.("navigation")[0] as PerformanceNavigationTiming | undefined,
  performance.timeOrigin,
  Date.now(),
)
// Debug only: ?at=<ISO time> freezes the page's clock there (the server rendered the first frame for it too), so any sky state
// renders deterministically for screenshots; ?pose=<az>,<alt> with it fakes the phone's pointing. / is no-store either way.
const QS = new URLSearchParams(location.search),
  at = Date.parse(QS.get("at") ?? "")
const atMs = Number.isFinite(at) && at > 63e9 && at < 5.6e12 ? at : null
window.__compute = K // read by the harnesses (home-states, journey, scrub), as window.__sky

const header = () => {
  const l = loc.peek()
  document.title = "ephem · the sky over " + l.city
  curl.value = { city: l.city, text: curlText(location.origin, l.lat, l.lon, l.tz, tNow()) }
}
const reloadAll = () => {
  DAYS.clear()
  K.ready = false
  K.started = false
  batch(() => {
    scrub.value = null
    track.value = []
    pos.value = null
    decl.value = null
    center.value = null
  })
  header()
  diag()
  return Promise.all([loadTrack(), loadPos(), loadDay(), loadWx()])
}
const locate = () => {
  if (!navigator.geolocation) {
    locNote.value = "This browser has no location API."
    return
  }
  locNote.value = "Asking your browser…"
  navigator.geolocation.getCurrentPosition(
    (g) => {
      loc.value = {
        lat: g.coords.latitude,
        lon: g.coords.longitude,
        place: "your location",
        city: "Your location",
        tz: loc.peek().tz,
        source: "device",
        acc: g.coords.accuracy,
      }
      locNote.value = ""
      history.replaceState(
        null,
        "",
        "?lat=" +
          loc.peek().lat.toFixed(4) +
          "&lon=" +
          loc.peek().lon.toFixed(4) +
          "&tz=" +
          encodeURIComponent(loc.peek().tz),
      )
      void reloadAll()
    },
    (e) => {
      locNote.value =
        e.code === 1 ? "Location permission denied; using Cloudflare's estimate." : "Couldn't get a location fix."
    },
    { enableHighAccuracy: true, timeout: 10000 },
  )
}
const share = () => {
  const l = loc.peek(),
    u =
      location.origin +
      "/?lat=" +
      l.lat.toFixed(4) +
      "&lon=" +
      l.lon.toFixed(4) +
      "&tz=" +
      encodeURIComponent(l.tz) +
      (l.source === "device" ? "" : "&place=" + encodeURIComponent(l.city))
  ;(navigator.clipboard ? navigator.clipboard.writeText(u) : Promise.reject(new Error("no clipboard"))).then(
    () => {
      locNote.value = "Link copied."
    },
    () => {
      locNote.value = u
    },
  )
}

const actions: Actions = {
  goLive,
  recenter,
  point: onPointClick,
  locate,
  share,
  hoodToggle: diag,
  rawToggle: (open) => {
    rawOpen.value = open
  },
  mountSky,
  mountStrip: setStripSvg,
  stripDown: onStripDown,
  stripMove: onStripMove,
  stripEnd: onStripEnd,
  stripCancel: onStripCancel,
  stripKey: onStripKey,
}

/** "Data drawn": when the server's first frame (the readouts' first value, Element Timing `ephem-data`) was painted, as the
 *  browser recorded it, marked `ephem:data` at that instant (journey.ts, RUM). Without a server frame (an answer was missing),
 *  the first frame this browser draws with an answer. */
const markData = (fromServer: boolean) => {
  const mark = (t: number, src: string) => {
    try {
      performance.mark("ephem:data", { startTime: t, detail: { source: src } })
    } catch {
      /* old browser */
    }
  }
  if (!fromServer) {
    const stop = effect(() => {
      if (pos.value) {
        mark(performance.now(), "first-client-frame")
        queueMicrotask(() => stop())
      }
    })
    return
  }
  try {
    const o = new PerformanceObserver((l) => {
      for (const e of l.getEntries() as Array<
        PerformanceEntry & { identifier?: string; renderTime?: number; loadTime?: number }
      >)
        if (e.identifier === "ephem-data") {
          mark(e.renderTime || e.startTime, "element-timing")
          o.disconnect()
          return
        }
    })
    o.observe({ type: "element", buffered: true })
  } catch {
    mark(performance.now(), "no-element-timing")
  }
}

// The first frame is the server's: it rendered the page from its own answers (/v1/position, /v1/track, /v1/day today and
// tomorrow, /v1/magnetic, embedded verbatim) at its instant. The same answers seed the same state here, at the same instant,
// so hydrating changes nothing (test/hydrate.test.tsx); then the page goes live: the real clock, the browser takeover,
// weather. Whatever the server left out is fetched.
// The boot is four tasks (seed, hydrate, go live, data) with a yield between each, so a tap or a scroll right after the frame
// paints waits for one of them, not for all: one 130–140 ms task at iPhone CPU 4× before, ≤ 62 ms after (boot-input.ts,
// 2026-10-31). The yield is a task (setTimeout 0), not scheduler.yield(): its continuations run ahead of a waiting tap
// (measured: input delay ~90 ms with scheduler.yield, ~60 ms with setTimeout, same build otherwise).
const yieldTask = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const start = async () => {
  const a = {
    position: embed<Position>("ephem-position"),
    track: embed<Track>("ephem-track"),
    day: embed<Day>("ephem-day"),
    tomorrow: embed<Day>("ephem-tomorrow"),
    magnetic: embed<Magnetic>("ephem-magnetic"),
  }
  seedFrame(boot, a)
  markData(!!a.position)
  await yieldTask()
  hydrate(<Header />, document.getElementById("hdr")!)
  hydrate(
    <ActionsContext.Provider value={actions}>
      <Home />
    </ActionsContext.Provider>,
    document.getElementById("app")!,
  )
  performance.mark?.("ephem:hydrated")
  await yieldTask()
  // live from here: the corrected clock (or ?at), the actual layout, the phone's controls
  env.clk = clk
  env.at = atMs
  env.atIso = atMs == null ? null : new Date(atMs).toISOString()
  startRum()
  const ps = atMs != null ? /^(-?[0-9.]+),(-?[0-9.]+)$/.exec(QS.get("pose") ?? "") : null
  if (ps)
    batch(() => {
      pose.value = { az: Number(ps[1]), alt: Number(ps[2]) }
      center.value = Number(ps[1])
    }) // the frame follows the pose, as a phone would
  initPointing()
  resize()
  drawStrip()
  header()
  diag()
  await yieldTask()
  const p = a.position,
    tr = a.track,
    dy = a.day
  if (p) {
    S.posAt = Date.now()
    S.posErr = null
    S.last = { url: "/v1/position?" + new URLSearchParams(q()).toString(), ms: null, prov: p.provenance }
    setPos(p)
  } else void loadPos()
  if (!tr) void loadTrack()
  if (!(dy && dy.date === localDate(tNow(), loc.peek().tz))) void loadDay()
  if (p) takeover(p)
  void loadWx()
  performance.mark?.(p && tr && dy ? "ephem:embedded" : "ephem:fetched")

  let rsT: ReturnType<typeof setTimeout> | undefined
  addEventListener("resize", () => {
    resize()
    clearTimeout(rsT)
    rsT = setTimeout(drawStrip, 150)
  })
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return
    if (K.ready) tick()
    else void loadPos()
  })
  loadFonts(() => {
    requestDraw()
    drawStrip()
  }) // after the first frame (src/client/fonts.ts); labels are laid out from the font's own metrics
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && scrub.peek() != null) goLive()
  })
  if (env.at == null)
    setInterval(() => {
      if (!document.hidden && !K.ready) void loadPos()
    }, 5000) // only until the browser takes over
  setInterval(() => {
    if (!document.hidden) void loadWx()
  }, 60e3)
  startClock()
}
void start()
