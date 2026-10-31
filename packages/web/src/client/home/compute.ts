// In-browser compute: the same @ephem/core the API runs (src/client/core.ts, its own lazily loaded chunk). The first frame is
// the server's (the embedded answers). Then the page loads the core module and the DE440 blocks it needs from immutable URLs,
// recomputes the server's position, track and day answers here and takes over only if every field agrees (lib/parity.ts);
// from then on the sky is computed in this browser, every second and on every scrub frame. Any failure leaves the page on the
// API (the 5 s /v1/position poll).
import { diffDay, diffPos, diffTrack, parityOk } from "../../lib/parity.ts"
import { blocksFor } from "../../lib/time.ts"
import type { Day, Position, Track } from "../../lib/types.ts"
import { startRum } from "../rum.ts"
import { tfetch } from "../trace.ts"
import { K, S, compute as computeSig, env, loc, scrubbable, type Parity } from "./state.ts"
import { applyTrack, diag, setPos } from "./data.ts"
import { tick } from "./tick.ts"

export { blocksFor }
type Core = typeof import("../core.ts")

/** A DE440 block the core needed and this page does not have yet. */
export class MissingBlock extends RangeError {
  constructor(readonly block: number) {
    super("DE440 block " + block + " is not loaded")
  }
}
export const isMissingBlock = (e: unknown): e is MissingBlock => e instanceof MissingBlock
const src = (i: number): ArrayBuffer => {
  const b = K.blocks.get(i)
  if (b) return b
  throw new MissingBlock(i)
}

/** Fetch DE440 blocks (8 144 B each, immutable URLs), de-duplicated while in flight. */
export const fetchBlocks = (list: ReadonlyArray<number>): Promise<void[]> =>
  Promise.all(
    list.map((i) => {
      if (K.blocks.has(i)) return Promise.resolve()
      let p = K.pending.get(i)
      if (!p) {
        p = tfetch(env.boot.sky.blocks + i)
          .then((r) => {
            if (!r.ok) throw new Error("DE440 block " + i + ": HTTP " + r.status)
            return r.arrayBuffer()
          })
          .then(
            (b) => {
              if (b.byteLength !== 8144) throw new Error("DE440 block " + i + ": " + b.byteLength + " B")
              K.blocks.set(i, b)
            },
            (e: unknown) => {
              K.pending.delete(i)
              throw e
            },
          )
        K.pending.set(i, p)
      }
      return p
    }),
  )

let core: Core | null = null
let coreP: Promise<Core> | null = null
// A page served before a deploy asks for its own version's hashed module: the next deploy carries the previous version's files
// (scripts/keep-assets.py), but if it is gone the page says so (Under the hood) and stays on the API.
const loadCore = (): Promise<Core> =>
  coreP ??
  (coreP = import("../core.ts").catch((e: unknown) => {
    coreP = null
    throw new Error(
      "the page's compute module did not load (" +
        (e instanceof Error ? e.message : String(e)) +
        "); if ephem was redeployed since this page loaded, reloading brings the new one",
    )
  }))

// The observer and refraction inputs exactly as the server used them (the answer's own observer and conventions): the
// ellipsoid height (the geoid N, as a number), temperature, pressure and the horizon's apparent altitude.
interface Obs {
  readonly geo: { readonly lat: number; readonly lon: number; readonly height: number }
  readonly T: number
  readonly P: number
  readonly H: number
}
let obs: Obs | null = null
const obsOf = (p: Position): Obs => {
  const c = p.conventions!,
    o = p.observer!
  if (o.heightEllipsoid == null) throw new Error("the answer has no observer.heightEllipsoid")
  return {
    geo: { lat: o.lat, lon: o.lon, height: o.heightEllipsoid },
    T: c.refraction.temperatureC,
    P: c.refraction.pressureHpa,
    H: c.horizon.altitude,
  }
}
const C = (): { core: Core; o: Obs } => {
  if (!core || !obs) throw new Error("the browser compute is not loaded")
  return { core, o: obs }
}
export const posAt = (t: number): Position => {
  const { core: c, o } = C()
  return c.position(src, { utcMs: t, geo: o.geo, temperature: o.T, pressure: o.P, horizon: o.H }) as Position
}
export const dayAt = (date: string): Day => {
  const { core: c, o } = C()
  return c.day(src, {
    date,
    tz: loc.peek().tz,
    geo: o.geo,
    temperature: o.T,
    pressure: o.P,
    horizon: o.H,
    limb: "upper",
  }) as Day
}
/** /v1/track's shape over [D − 2, D + 3) days on the 20-minute UTC grid: the API's samples (the same grid points) and enough on
 *  both sides for now ± 12.4 h anywhere in today's timeline, so a scrub never runs off the track. */
export const trackFor = (D: number): Track => {
  const { core: c, o } = C(),
    a = (D - 2) * 864e5,
    b = (D + 3) * 864e5
  const r = c.track(src, {
    startMs: a,
    endMs: b,
    stepMs: 1200e3,
    geo: o.geo,
    temperature: o.T,
    pressure: o.P,
    horizon: o.H,
  })
  return { start: new Date(a).toISOString(), stepSeconds: 1200, count: r.count, sun: r.sun, moon: r.moon, D }
}

/** One task per step (position, track, day, then the takeover), so none is a long task on a slow phone (64 ms in one, CPU 4×). */
const step =
  <A, B>(f: (x: A) => B) =>
  (x: A) =>
    new Promise<B>((ok) => {
      setTimeout(() => ok(f(x)), 0)
    })

/** Take over from the server's first frame (p: its /v1/position answer). Tolerances: lib/parity.ts PARITY_TOL. */
export const takeover = (p: Position | null) => {
  if (K.started || !p || !p.conventions || !p.time) return
  K.started = true
  K.err = null
  computeSig.value = { ready: false, started: true, err: null }
  const t = Date.parse(p.time.utc),
    D = Math.floor(t / 864e5)
  const need = blocksFor(Math.min(t, (D - 2) * 864e5), Math.max(t, (D + 3) * 864e5))
  const par: Parity = { at: p.time.utc }
  let tr: Track | null = null,
    ms = 0
  Promise.all([loadCore(), fetchBlocks(need)])
    .then(
      step(([c]: [Core, unknown]) => {
        core = c
        obs = obsOf(p)
        const t0 = performance.now(),
          mine = posAt(t)
        ms = performance.now() - t0
        par.pos = diffPos(p, mine)
      }),
    )
    .then(
      step(() => {
        tr = trackFor(D)
        if (S.trackApi) par.track = diffTrack(S.trackApi, tr)
      }),
    )
    .then(
      step(() => {
        if (S.dayApi) par.day = diffDay(S.dayApi, dayAt(S.dayApi.date))
      }),
    )
    .then(
      step(() => {
        K.parity = par
        const pp = { pos: par.pos!, track: par.track, day: par.day }
        if (!parityOk(pp)) {
          const bad = pp.pos.bad.concat(pp.track?.bad ?? [], pp.day?.bad ?? [])
          throw new Error(
            "the browser disagrees with the server at " +
              p.time.utc +
              (bad.length
                ? ": " + bad.slice(0, 3).join(", ")
                : ": " + JSON.stringify([pp.pos.deg, pp.pos.km, pp.track?.deg, pp.day?.ms])),
          )
        }
        K.ready = true
        K.ms = ms
        K.at = Date.now()
        computeSig.value = { ready: true, started: true, err: null }
        performance.mark?.("ephem:core")
        startRum().mark("core-takeover", "fields " + (pp.pos.n + (pp.track?.n ?? 0) + (pp.day?.n ?? 0)))
        applyTrack(tr!)
        scrubbable.value = true
        tick(true)
        diag()
      }),
    )
    .catch((e: unknown) => {
      K.err = e instanceof Error ? e.message : String(e)
      K.ready = false
      K.started = false
      computeSig.value = { ready: false, started: false, err: K.err }
      diag()
    })
}

/** Live: the sky at now (or at the scrubbed instant), computed here. A missing block (a scrub or a clock across a 32-day block
 *  edge) is fetched and the frame waits for it. */
export const computeAt = (t: number, dragging: boolean): boolean => {
  try {
    const t0 = performance.now(),
      p = posAt(t)
    K.ms = performance.now() - t0
    S.posAt = Date.now()
    S.posErr = null
    setPos(p, dragging)
    return true
  } catch (e) {
    if (isMissingBlock(e))
      fetchBlocks([e.block]).then(
        () => tick(true),
        (x: unknown) => {
          K.err = x instanceof Error ? x.message : String(x)
        },
      )
    else {
      K.err = e instanceof Error ? e.message : String(e)
      K.ready = false
      computeSig.value = { ready: false, started: K.started, err: K.err }
    }
    return false
  }
}
