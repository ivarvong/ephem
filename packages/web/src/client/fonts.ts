// "Ephem DIN" for the homepage, added after the first frame has booted (not from the stylesheet, where the browser would fetch
// both files at first paint, sharing a slow link with the page's module and its first answers: measured +95 ms to data drawn on
// iPhone Fast 3G, docs/telemetry_and_profiling.md "Homepage"). Self-hosted, content-hashed static assets (Vite emits them; the
// server's manifest records their sha256, which glyph pins). The page paints in the system face first and swaps, as before.
import regular from "../fonts/ephem-din-regular.woff2?url"
import bold from "../fonts/ephem-din-bold.woff2?url"

export const FONT_URLS = { regular, bold } as const
/** Add both weights; `done` runs when they are in (the canvas and the timeline re-measure their text). */
export const loadFonts = (done: () => void) => {
  if (typeof FontFace === "undefined" || !document.fonts) return
  const faces = [new FontFace("Ephem DIN", `url("${regular}") format("woff2")`, { weight: "400", display: "swap" }), new FontFace("Ephem DIN", `url("${bold}") format("woff2")`, { weight: "700", display: "swap" })]
  for (const f of faces) document.fonts.add(f)
  Promise.all(faces.map(f => f.load())).then(done, () => { /* the system faces stay */ })
}
