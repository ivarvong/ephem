// Under the hood's diagnostics and the telemetry footer: what answered, from where, how fast, and what this browser computes.
// Recomputed when diagRev moves (at most once a second, never during a drag; src/client/home/data.ts diag / diagSoon). Every
// value is a recorded one (an answer's provenance, Resource Timing, the takeover's own measurements) or says "not recorded".
import { computed } from "@preact/signals"
import { d2 } from "../../lib/words.ts"
import { ago } from "../../lib/words.ts"
import { K, S, apiErr, decl, diagRev, env, loc, pos, wx } from "../../client/home/state.ts"

/** A line of the diagnostics: segments, each plain, a comment (`c`) or an error (`err`). */
export type Seg = { readonly t: string; readonly cls?: "c" | "err" }
export type DiagLine = ReadonlyArray<Seg>
const pad = (k: string) => (k.toUpperCase() + "                    ").slice(0, 18)
const plain = (t: string): DiagLine => [{ t }]
const comment = (t: string): DiagLine => [{ t, cls: "c" }]

/** What this browser recorded about a URL it fetched (Resource Timing): bytes over the network, or from its cache. */
const fetched = (path: string): string => {
  const e = performance.getEntriesByName?.(location.origin + path)[0] as PerformanceResourceTiming | undefined
  if (!e) return "not recorded"
  return e.transferSize > 0
    ? (e.encodedBodySize / 1000).toFixed(1) + " kB over the network, " + Math.round(e.duration) + " ms"
    : e.decodedBodySize > 0
      ? "from this browser's cache"
      : "size not recorded"
}
const sci = (x: number) => (x === 0 ? "0" : x.toExponential(1))
const cacheParts = (c: Record<string, number>) =>
  ["L1 " + c["l1"]].concat(
    Object.keys(c)
      .filter((k) => k.startsWith("blocks_"))
      .map((k) => k.slice(7) + " " + c[k]),
  )

export const diagLines = computed((): ReadonlyArray<DiagLine> | null => {
  if (!diagRev.value) return null
  const out: DiagLine[] = [],
    last = S.last,
    sky = env.boot.sky,
    colo = env.boot.loc.colo,
    l = loc.peek(),
    dc = decl.peek(),
    w = wx.peek()
  if (last) {
    const d = last.prov?.diagnostics,
      c = d?.cache
    out.push(
      comment("# " + (last.ms == null ? "first frame: computed on Cloudflare" : "last position answer from the API")),
      plain("GET " + last.url),
      plain(pad("round trip") + (last.ms == null ? "none: embedded in the page" : last.ms.toFixed(1) + " ms")),
    )
    if (pos.peek() && last.ms == null && K.parity) out.push(plain(pad("server instant") + K.parity.at))
    if (d && c)
      out.push(
        plain(pad("DE440 blocks") + d.blocks.join(", ")),
        plain(pad("cache") + cacheParts(c).join(", ")),
        plain(pad("coefficient reads") + c.reads),
      )
    out.push(
      plain(
        pad("served by") +
          "Cloudflare" +
          (colo ? " " + colo : " (colo not recorded)") +
          ", ephem " +
          (last.prov?.version ?? "") +
          (K.ready ? "" : ", refreshed every 5 s"),
      ),
    )
  }
  out.push(plain(""), comment("# " + (K.ready ? "since then: computed in this browser" : "in this browser")))
  if (K.ready && K.parity?.pos) {
    const pr = K.parity,
      bl = [...K.blocks.keys()].toSorted((a, b) => a - b)
    out.push(
      plain(pad("code") + "@ephem/core " + sky.coreId + " (" + sky.core + ": " + fetched(sky.core) + ")"),
      plain(
        pad("DE440 blocks") +
          bl.join(", ") +
          " (8 144 B each, " +
          sky.blocks +
          "N: " +
          [...new Set(bl.map((i) => fetched(sky.blocks + i)))].join("; ") +
          ")",
      ),
      plain(
        pad("vs the server") +
          "at " +
          pr.at +
          ": position " +
          pr.pos!.n +
          " fields, max |Δ| " +
          sci(pr.pos!.deg) +
          "°, " +
          sci(pr.pos!.km) +
          " km" +
          (pr.track ? "; track " + pr.track.n + " values, " + sci(pr.track.deg) + "°" : "") +
          (pr.day ? "; day " + pr.day.n + " events, " + pr.day.ms + " ms" : ""),
      ),
      plain(
        pad("last compute") +
          (K.ms == null ? "not recorded" : K.ms.toFixed(2) + " ms (position, Sun and Moon), every second") +
          (K.frames
            ? "; last drag " +
              K.frames.n +
              " frames, " +
              K.frames.mean.toFixed(1) +
              " ms mean, " +
              K.frames.max.toFixed(1) +
              " ms max"
            : ""),
      ),
    )
  } else if (K.err) out.push([{ t: pad("compute") }, { t: K.err, cls: "err" }, { t: "; the API answers instead" }])
  else out.push(plain(pad("compute") + (K.started ? "loading " + sky.core + "…" : "the API")))
  const c = env.clk
  out.push(
    plain(
      pad("clock") +
        "device " +
        (c.off >= 0 ? "behind" : "ahead of") +
        " Cloudflare by " +
        (Math.abs(c.off) / 1000).toFixed(2) +
        " s ± " +
        (c.pm / 1000).toFixed(2) +
        " s" +
        (c.nt ? " (Navigation Timing)" : " (no Navigation Timing: an upper bound)") +
        "; the page shows Cloudflare's time",
    ),
  )
  if (w) {
    const f = w.feed,
      dt = (Date.now() - S.wxAt) / 1000
    out.push(
      plain(""),
      comment("# weather feed"),
      plain(
        pad("feed fetched") +
          ago(f.ageSeconds + dt) +
          (f.stale ? " (stale)" : "") +
          (f.tier === "stale-on-error" ? " (upstream unreachable)" : ""),
      ),
      plain(pad("file updated") + (f.upstreamAgeSeconds != null ? ago(f.upstreamAgeSeconds + dt) : "not recorded")),
      plain(pad("stations in feed") + f.stations.toLocaleString("en-US")),
      plain(pad("cache tier") + f.tier),
    )
  }
  out.push(
    plain(""),
    comment("# location"),
    plain(
      pad("coordinates") +
        l.lat.toFixed(5) +
        ", " +
        l.lon.toFixed(5) +
        (l.source === "device" && l.acc != null ? " (±" + Math.round(l.acc) + " m)" : ""),
    ),
    plain(pad("time zone") + l.tz),
    plain(
      pad("source") +
        (l.source === "cloudflare"
          ? "Cloudflare geolocation" + (colo ? ", " + colo : "")
          : l.source === "device"
            ? "your device"
            : l.source === "query"
              ? "the link"
              : "default"),
    ),
    plain(
      pad("declination") + (dc == null ? "not received yet" : d2(Math.abs(dc)) + (dc < 0 ? " W" : " E") + " (WMM2025)"),
    ),
  )
  return out
})

/** The telemetry bar: provenance stays on screen, the detail lives in Under the hood. */
export const footer = computed((): ReadonlyArray<readonly [string, string]> | { readonly err: string } | null => {
  const e = apiErr.value
  if (e) return { err: "The API answered with an error: " + e }
  if (!diagRev.value) return null
  const last = S.last,
    prov = last?.prov,
    c1 = prov?.diagnostics?.cache,
    l = loc.peek(),
    colo = env.boot.loc.colo
  const out: Array<readonly [string, string]> = [
    ["ephem", prov?.version ?? ""],
    ["Ephemeris", prov?.sources?.[0] ?? "JPL DE440"],
  ]
  if (K.ready)
    out.push(["Computed", "first frame on Cloudflare, now in this browser · core " + env.boot.sky.coreId.slice(0, 8)])
  if (last && !K.ready) out.push(["Round trip", last.ms == null ? "embedded" : last.ms.toFixed(1) + " ms"])
  if (c1 && !K.ready) out.push(["Block cache", cacheParts(c1).join(" · ")])
  if (colo) out.push(["Edge", colo])
  out.push([
    "Location",
    l.source === "cloudflare"
      ? "approximate, from Cloudflare"
      : l.source === "device"
        ? "from your device"
        : l.source === "query"
          ? "from the link"
          : "default",
  ])
  return out
})
