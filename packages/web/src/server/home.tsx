// The homepage document, server side. The Worker (packages/worker/src/home.ts) streams it in two parts:
//   head  renderHomeHead: <head> (the build's stylesheet inline, the module and its preloads, the boot JSON) and the header
//         (its own hydration root), flushed at once, so the browser styles and paints the header while the server computes
//   body  renderHomeBody: the whole first frame rendered from the server's own answers (components/home/Home.tsx: the SVG
//         sky chart with its tracks, discs and labels, the countdown, the timeline, the readouts), then those answers as
//         <script type="application/json" id="ephem-…"> (the API's own bodies, for the browser to seed the same state and
//         hydrate), then </body>. The sky and the numbers are on screen as soon as this is parsed: no script on that path.
// State: the components read module-level signals (client/home/state.ts); each render here seeds them (frame.ts), renders
// synchronously and resets them, so concurrent requests in an isolate never see each other's state.
// No inline executable script anywhere (CSP script-src 'self'; test/csp.test.ts).
import { renderToString } from "preact-render-to-string"
import { ICON_HREF } from "../lib/icon.ts"
import type { Day, Magnetic, Position, Track, Visitor } from "../lib/types.ts"
import { resetState, type Boot } from "../client/home/state.ts"
import { seedFrame, type FirstAnswers } from "../client/home/frame.ts"
import { nominalFrame } from "../client/home/model.ts"
import { Header, Home } from "../components/home/Home.tsx"
import { assets, coreId } from "./assets.ts"
import { jsonText } from "./json.ts"

/** A head tag the Worker adds (the link-preview tags, packages/worker/src/og.ts). */
export type HeadTag =
  | { readonly property: string; readonly content: string }
  | { readonly name: string; readonly content: string }
  | { readonly rel: string; readonly href: string }
export interface HomeHead {
  readonly v: Visitor
  /** the document's traceparent (00-<trace>-<span>-01), validated by the Worker, and whether the request was synthetic */
  readonly traceparent?: string | undefined
  readonly synthetic?: boolean | undefined
  readonly og?: ReadonlyArray<HeadTag> | undefined
  /** where DE440 blocks live; the server's clock as it writes the head; the instant the first frame shows (now, or ?at) */
  readonly blocks: string
  readonly now: number
  readonly at?: number | undefined
  /** the page's origin (its curl lines) and whether the request came from a phone (the first frame's layout) */
  readonly origin?: string | undefined
  readonly mobile?: boolean | undefined
}
/** The first answers as the Worker got them: [element id, the API's JSON text]. */
export type Embeds = ReadonlyArray<readonly [id: string, json: string]>

const Tag = ({ t }: { readonly t: HeadTag }) =>
  "property" in t ? (
    <meta property={t.property} content={t.content} />
  ) : "name" in t ? (
    <meta name={t.name} content={t.content} />
  ) : (
    <link rel={t.rel} href={t.href} />
  )
const Json = ({ id, json }: { readonly id: string; readonly json: string }) => (
  <script type="application/json" id={id} dangerouslySetInnerHTML={{ __html: jsonText(json) }} />
)

/** What the page boots with (#ephem-boot): the browser seeds its state from it and the embeds exactly as this server did. */
export const bootOf = (h: HomeHead): Boot => {
  const a = assets()
  return {
    loc: h.v,
    sky: { core: a.core.js, coreId: coreId(a), blocks: h.blocks, now: h.now },
    origin: h.origin ?? "",
    at: h.at ?? h.now,
    frame: nominalFrame(!!h.mobile),
  }
}

const Head = ({ h, boot }: { readonly h: HomeHead; readonly boot: Boot }) => {
  const a = assets()
  return (
    <head>
      <meta charset="utf-8" />
      {h.traceparent ? <meta name="traceparent" content={h.traceparent} /> : null}
      {h.traceparent && h.synthetic ? <meta name="ephem-synthetic" content="1" /> : null}
      <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
      <title>{"ephem · the sky over " + h.v.city.replace(/[<>&"]/g, "")}</title>
      <meta
        name="description"
        content="Where the Sun and the Moon are right now, from JPL DE440, computed on Cloudflare's edge."
      />
      <meta name="theme-color" content="#07090c" />
      <meta name="color-scheme" content="dark" />
      {(h.og ?? []).map((t) => (
        <Tag t={t} />
      ))}
      <link rel="icon" type="image/svg+xml" href={ICON_HREF} />
      {a.css.text ? <style dangerouslySetInnerHTML={{ __html: a.css.text }} /> : null}
      {a.home.preload.map((p) => (
        <link rel="modulepreload" href={p} />
      ))}
      {(a.dev?.scripts ?? []).map((s) => (
        <script type="module" src={s} />
      ))}
      <script type="module" src={a.home.js} />
      <Json id="ephem-boot" json={JSON.stringify(boot)} />
    </head>
  )
}

const parse = <T,>(embeds: Embeds, id: string): T | null => {
  const e = embeds.find(([k]) => k === id)
  try {
    return e ? (JSON.parse(e[1]) as T) : null
  } catch {
    return null
  }
}
/** The embedded answers as the page reads them (client/home.tsx does the same with the elements' text). */
export const answersOf = (embeds: Embeds): FirstAnswers => ({
  position: parse<Position>(embeds, "ephem-position"),
  track: parse<Track>(embeds, "ephem-track"),
  day: parse<Day>(embeds, "ephem-day"),
  tomorrow: parse<Day>(embeds, "ephem-tomorrow"),
  magnetic: parse<Magnetic>(embeds, "ephem-magnetic"),
})
/** Render with state seeded for this request, then reset it (synchronous: nothing else runs in between). */
const seeded = (boot: Boot, a: FirstAnswers, render: () => string): string => {
  try {
    seedFrame(boot, a)
    return render()
  } finally {
    resetState()
  }
}
const NONE: FirstAnswers = { position: null, track: null, day: null, tomorrow: null, magnetic: null }

/** <!doctype>, <html>, the head and the header: sent at once. Ends inside <body>. */
export const renderHomeHead = (h: HomeHead): string => {
  const boot = bootOf(h)
  return (
    `<!doctype html><html lang="en" class="home">${renderToString(<Head h={h} boot={boot} />)}<body>` +
    seeded(boot, NONE, () => `<div id="hdr">${renderToString(<Header />)}</div>`)
  )
}
/** The first frame, from the server's answers, then the answers themselves, then </body></html>. */
export const renderHomeBody = (h: HomeHead, embeds: Embeds): string =>
  seeded(bootOf(h), answersOf(embeds), () => `<div id="app">${renderToString(<Home />)}</div>`) +
  embeds.map(([id, json]) => renderToString(<Json id={id} json={json} />)).join("") +
  "</body></html>"

/** The whole page (tests). */
export const renderHomeStatic = (h: HomeHead, embeds: Embeds = []): string =>
  renderHomeHead(h) + renderHomeBody(h, embeds)
