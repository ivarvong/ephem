// The client build's manifest (dist/assets.json, written by scripts/build-web.ts): what the pages reference. Every URL is
// content-hashed and served by Workers Static Assets with `public, max-age=31536000, immutable` (dist/client/_headers).
// In dev (packages/worker/src/dev.ts with EPHEM_VITE=1) the pages point at Vite's dev server instead (setDevAssets).
import built from "../../dist/assets.json" with { type: "json" }

export interface Font {
  readonly href: string
  readonly sha256: string
  readonly bytes: number
}
export interface Assets {
  readonly home: { readonly js: string; readonly preload: ReadonlyArray<string> }
  readonly core: { readonly js: string; readonly preload: ReadonlyArray<string> }
  readonly scalar: { readonly js: string }
  /** the stylesheet: its URL, its text (inlined in the homepage's head) and the CSP hash of that text */
  readonly css: { readonly href: string; readonly text: string; readonly sha256: string }
  readonly fonts: { readonly regular: Font; readonly bold: Font }
  /** dev only: extra module scripts (Vite's client) and no inline CSS */
  readonly dev?: { readonly scripts: ReadonlyArray<string> }
}
let current: Assets = built
export const assets = (): Assets => current
/** The pages load Vite's dev modules (HMR) instead of the build. */
export const setDevAssets = (origin = "") => {
  current = {
    ...built,
    home: { js: origin + "/src/client/home.tsx", preload: [] },
    core: { js: origin + "/src/client/core.ts", preload: [] },
    scalar: { js: origin + "/src/client/scalar.ts" },
    css: { ...built.css, text: "" },
    dev: { scripts: [origin + "/@vite/client"] },
  }
}
/** The core module's short id: the content hash in its file name (shown in the page's diagnostics). */
export const coreId = (a: Assets = current): string => /-([A-Za-z0-9_-]{8,})\.js$/.exec(a.core.js)?.[1] ?? "dev"
