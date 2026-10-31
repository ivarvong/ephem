// The first frame's state, from the server's own answers. The server seeds it, renders the page synchronously and resets it
// (src/server/home.tsx); the browser seeds it identically, from the same answers embedded in the page and the same instant,
// before it hydrates, so the hydrated DOM is the server's (test/hydrate.test.tsx). Pure: no DOM, timers or fetch.
import { batch } from "@preact/signals"
import { localDate, nextDate } from "../../lib/time.ts"
import type { Day, Magnetic, Position, Track } from "../../lib/types.ts"
import {
  DAYS,
  S,
  baseTime,
  center,
  ctlRect,
  curl,
  day,
  decl,
  env,
  loc,
  now,
  pointing,
  pos,
  skySize,
  strip,
  nowX,
  scrubX,
  tomorrow,
  track,
  type Boot,
} from "./state.ts"
import { computeStrip, defaultCenter, pointRect, stripMarks, trackRows } from "./model.ts"

/** The answers the server embeds (`<script type="application/json" id="ephem-…">`), each null when it was not in time. */
export interface FirstAnswers {
  readonly position: Position | null
  readonly track: Track | null
  readonly day: Day | null
  readonly tomorrow: Day | null
  readonly magnetic: Magnetic | null
}

/** The curl lines in Under the hood, for the location and instant. */
export const curlText = (origin: string, lat: number, lon: number, tz: string, t: number): string => {
  const ll = "lat=" + lat.toFixed(4) + "&lon=" + lon.toFixed(4),
    D = Math.floor(t / 864e5)
  return (
    "curl '" +
    origin +
    "/v1/position?" +
    ll +
    "'\n\n" +
    "curl '" +
    origin +
    "/v1/track?" +
    ll +
    "&start=" +
    new Date((D - 1) * 864e5).toISOString().slice(0, 19) +
    "Z&end=" +
    new Date((D + 2) * 864e5).toISOString().slice(0, 19) +
    "Z'\n\n" +
    "curl '" +
    origin +
    "/v1/day?" +
    ll +
    "&date=" +
    localDate(t, tz) +
    "&tz=" +
    tz +
    "'\n\n" +
    "curl '" +
    origin +
    "/v1/weather?" +
    ll +
    "&count=3'"
  )
}

/** Seed the state for the first frame at the boot's instant. `frozen`: the page clock is fixed (?at). */
export const seedFrame = (boot: Boot, a: FirstAnswers) => {
  const t = boot.at,
    l = { ...boot.loc, acc: null }
  env.boot = boot
  batch(() => {
    loc.value = l
    curl.value = { city: l.city, text: curlText(boot.origin, l.lat, l.lon, l.tz, t) }
    now.value = t
    baseTime.value = t
    skySize.value = { W: boot.frame.W, H: boot.frame.H, insetL: 0, insetR: 0 }
    pointing.value = boot.frame.mobile ? "off" : "hidden"
    ctlRect.value = boot.frame.mobile ? pointRect(boot.frame.W) : null
    if (a.magnetic?.magnetic) decl.value = a.magnetic.magnetic.declination
    if (a.track) {
      track.value = trackRows(a.track)
      S.trackApi = a.track
      S.trackDay = Math.round(Date.parse(a.track.start) / 864e5) + 1
    }
    const today = localDate(t, l.tz)
    if (a.day && a.day.date === today) {
      day.value = a.day
      S.dayApi = a.day
      DAYS.set(a.day.date, a.day)
      if (a.tomorrow && a.tomorrow.date === nextDate(a.day.date)) {
        tomorrow.value = a.tomorrow
        DAYS.set(a.tomorrow.date, a.tomorrow)
        S.tomorrowFor = a.day.date
      }
    }
    if (a.position) {
      pos.value = a.position
      center.value = defaultCenter(a.position)
    }
    const s = computeStrip(boot.frame.strip, t, t, () => undefined)
    strip.value = s
    if (s) {
      const mk = stripMarks(s, t, t, false)
      nowX.value = mk.now
      scrubX.value = mk.scrub
    }
  })
}
