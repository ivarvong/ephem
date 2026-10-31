// The homepage's state. Signals for what the DOM shows (components bind them to text and attributes, so the every-second
// updates patch text nodes without re-rendering trees); plain fields for what only the loaders and the takeover read.
// The server renders the first frame from this same state, seeded from its own answers (src/client/home/frame.ts) and reset
// after the (synchronous) render; the browser seeds it identically before it hydrates, so the two DOMs are the same.
import { batch, signal } from "@preact/signals"
import type { ClockOffset } from "../../lib/time.ts"
import type { Pose } from "../../lib/pose.ts"
import type { TlLayout } from "../../lib/timeline.ts"
import type { DayDiff, PosDiff, TrackDiff } from "../../lib/parity.ts"
import type { Rect } from "../../lib/labels.ts"
import type { Day, Position, Provenance, Track, Visitor, Weather } from "../../lib/types.ts"

/** What the server hands the page in its head (`<script type="application/json" id="ephem-boot">`, src/server/home.tsx). */
export interface Boot {
  readonly loc: Visitor
  /** the in-browser compute: the core module's URL and short id, where DE440 blocks live, and the server's clock as it wrote the head */
  readonly sky: { readonly core: string; readonly coreId: string; readonly blocks: string; readonly now: number }
  /** the page's origin (the curl lines), the instant the first frame shows (the server's now, or ?at), and the layout the
   *  server drew it for: the chart's size and the timeline's width (a phone or a desktop, from the request's UA) and whether
   *  the point button shows (a phone) */
  readonly origin: string
  readonly at: number
  readonly frame: { readonly W: number; readonly H: number; readonly strip: number; readonly mobile: boolean }
}
export interface Loc {
  readonly lat: number; readonly lon: number; readonly place: string; readonly city: string; readonly tz: string
  readonly source: Visitor["source"] | "device"; readonly acc: number | null
}
export interface TrackRow { readonly t: number; readonly sun: Sample; readonly moon: Sample }
export interface Sample { readonly azimuth: number; readonly altitude: number; readonly apparentAltitude: number | null }
export interface Last { readonly url: string; readonly ms: number | null; readonly prov: Provenance | undefined }
export interface Parity { readonly at: string; pos?: PosDiff; track?: TrackDiff; day?: DayDiff }

// ---- set once at boot ----
export const env = {
  boot: null as unknown as Boot,
  clk: { off: 0, pm: 0, nt: false } as ClockOffset,
  /** ?at=<ISO>: the page clock frozen there (debug: deterministic screenshots of any sky state) */
  at: null as number | null,
  atIso: null as string | null,
}

// ---- signals: the DOM ----
export const loc = signal<Loc>({ lat: 0, lon: 0, place: "", city: "", tz: "UTC", source: "default", acc: null })
/** the live answer on screen (the server's embed, the API's, or this browser's) */
export const pos = signal<Position | null>(null)
/** today (a placeholder with loading: true while /v1/day is in flight) */
export const day = signal<(Day & { readonly loading?: boolean }) | null>(null)
export const tomorrow = signal<Day | null>(null)
export const track = signal<ReadonlyArray<TrackRow>>([])
/** WMM2025 declination, east positive */
export const decl = signal<number | null>(null)
export const wx = signal<Weather | null>(null)
export const wxErr = signal<string | null>(null)
/** ms from now while the timeline is dragged (null = live) */
export const scrub = signal<number | null>(null)
export const pose = signal<Pose | null>(null)
/** the page's time: base clock (Cloudflare's, or ?at) + scrub; set by every tick */
export const now = signal(0)
/** the header clock's time (never scrubbed) */
export const baseTime = signal(0)
/** bumped by every tick: what reads the wall clock (data age, the LIVE dot) follows it even when the page time is frozen (?at) */
export const tickRev = signal(0)
/** the footer's API error, or null */
export const apiErr = signal<string | null>(null)
/** bumped when the diagnostics should be redrawn (at most once a second, never during a drag) */
export const diagRev = signal(0)
export const compute = signal<{ readonly ready: boolean; readonly started: boolean; readonly err: string | null }>({ ready: false, started: false, err: null })
/** the point button's state: hidden (no compass), off, on */
export const pointing = signal<"hidden" | "off" | "on">("hidden")
export const guideText = signal<{ readonly text: string; readonly label: string | null; readonly sim: boolean } | null>(null)
export const recenterShown = signal(false)
export const rawOpen = signal(false)
export const locNote = signal("")
/** the place in the header and the curl lines in Under the hood (set at boot and when the location changes) */
export const curl = signal<{ readonly city: string; readonly text: string }>({ city: "", text: "" })
export const scrubbable = signal(false)
/** the chart's frame centre (azimuth, deg); null until the first answer */
export const center = signal<number | null>(null)
/** the chart's size in CSS px and the safe-area insets (the server's guess for the first frame, then measured) */
export const skySize = signal<{ readonly W: number; readonly H: number; readonly insetL: number; readonly insetR: number }>({ W: 0, H: 0, insetL: 0, insetR: 0 })
/** the chart's corner buttons as a hard rect in the label layout (null: none shows) */
export const ctlRect = signal<Rect | null>(null)
/** bumped to redraw the chart (fonts, a new frame) */
export const chartRev = signal(0)
/** the timeline as drawn (null: nothing yet; src/client/home/strip.ts) */
export interface Strip { readonly L: TlLayout; readonly w: number; readonly anchor: number; readonly s0: number; readonly span: number; readonly k: number }
export const strip = signal<Strip | null>(null)
/** the NOW marker's x (null: off the window) and the scrub cursor's (null: live) */
export const nowX = signal<number | null>(null)
export const scrubX = signal<number | null>(null)

// ---- plain state: canvas, loaders, takeover ----
export const S = {
  posAt: 0 as number,
  posErr: null as unknown,
  last: null as Last | null,
  dayApi: null as Day | null,
  trackApi: null as Track | null,
  trackDay: null as number | null,
  tomorrowFor: null as string | null,
  wxAt: 0,
  userPanned: false,
}
/** Every local day the page has (the timeline spans two). */
export const DAYS = new Map<string, Day>()
/** the browser takeover (src/client/home/compute.ts) */
export const K = {
  ready: false,
  started: false,
  blocks: new Map<number, ArrayBuffer>(),
  pending: new Map<number, Promise<void>>(),
  parity: null as Parity | null,
  err: null as string | null,
  ms: null as number | null,
  at: null as number | null,
  frames: null as { readonly n: number; readonly mean: number; readonly max: number } | null,
}
/** the drag on the timeline in progress (src/client/home/strip.ts) */
export const SC = { cur: null as null | { id: number; x: number; y: number; on: boolean; t0: number; n: number; sum: number; max: number } }

export const realNow = (): number => Date.now() + env.clk.off
export const baseNow = (): number => (env.at == null ? realNow() : env.at)
export const tNow = (): number => baseNow() + (scrub.peek() ?? 0)

/** Every signal and plain field back to its initial value: the server renders each request's first frame from seeded state
 *  inside one synchronous render (an isolate serves one request at a time between awaits), then calls this. */
export const resetState = () => {
  batch(() => {
    loc.value = { lat: 0, lon: 0, place: "", city: "", tz: "UTC", source: "default", acc: null }
    pos.value = null; day.value = null; tomorrow.value = null; track.value = []; decl.value = null; wx.value = null; wxErr.value = null
    scrub.value = null; pose.value = null; now.value = 0; baseTime.value = 0; tickRev.value = 0; apiErr.value = null; diagRev.value = 0
    compute.value = { ready: false, started: false, err: null }; pointing.value = "hidden"; guideText.value = null; recenterShown.value = false
    rawOpen.value = false; locNote.value = ""; curl.value = { city: "", text: "" }; scrubbable.value = false; center.value = null
    skySize.value = { W: 0, H: 0, insetL: 0, insetR: 0 }; ctlRect.value = null; chartRev.value = 0; strip.value = null; nowX.value = null; scrubX.value = null
  })
  Object.assign(S, { posAt: 0, posErr: null, last: null, dayApi: null, trackApi: null, trackDay: null, tomorrowFor: null, wxAt: 0, userPanned: false })
  DAYS.clear()
  Object.assign(env, { boot: null, clk: { off: 0, pm: 0, nt: false }, at: null, atIso: null })
}
