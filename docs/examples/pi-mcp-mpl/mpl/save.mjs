import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

/** Write an mpljs Figure to PNG and a font-independent, outlined-text SVG. */
export function saveFigure(fig, renderer, { name = "chart", outDir }) {
  if (!outDir) throw new TypeError("saveFigure requires outDir")
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new TypeError("name must be a simple file stem")
  const dir = resolve(outDir)
  mkdirSync(dir, { recursive: true })
  const svg = resolve(dir, `${name}.svg`)
  const png = resolve(dir, `${name}.png`)
  // Use mpl's public scene renderer so every glyph is an outline, not a
  // viewer-dependent <text> element. The pinned API names this mode "glyphs".
  writeFileSync(svg, renderer.toSVG(fig.toScene(), renderer.tracer, "glyphs"))
  writeFileSync(png, fig.toPNGSync())
  return { png, svg }
}
