// Content-Security-Policy per page. No page runs an inline script: every script is a same-origin, content-hashed module
// (hydration data rides in <script type="application/json">, which is not executed), so script-src is 'self' with no
// 'unsafe-inline', no nonces and no hashes. The homepage's one inline <style> is the build's stylesheet (scripts/build-web.ts),
// allowed by its sha256. test/csp.test.ts asserts the headers and that no page holds an inline executable script or an
// inline event handler.
import { assets } from "./assets.ts"

/** Scalar's standalone bundle, pinned by version and integrity (/docs/interactive). */
export const SCALAR = {
  src: "https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.74.0/dist/browser/standalone.js",
  integrity: "sha384-VXnKAz61Xwc3tbw1P+KKrUP7YbcsSl1Ik4is5UnogJyw9XEYZ5Ay/T1i0zPYtSZH",
} as const

const join = (d: Record<string, ReadonlyArray<string>>) => Object.entries(d).map(([k, v]) => [k, ...v].join(" ")).join("; ")
const BASE = { "default-src": ["'none'"], "base-uri": ["'none'"], "form-action": ["'self'"], "object-src": ["'none'"], "img-src": ["'self'", "data:"] }

const dev = () => !!assets().dev
/** /: our modules, our fonts, our API; the inlined stylesheet by hash (dev: Vite injects styles and talks HMR over a socket). */
export const homeCsp = (): string => join({
  ...BASE,
  "script-src": ["'self'"],
  "style-src": dev() ? ["'self'", "'unsafe-inline'"] : ["'self'", `'sha256-${assets().css.sha256}'`],
  "font-src": ["'self'"],
  "connect-src": dev() ? ["'self'", "ws:"] : ["'self'"],
})
/** /docs: plain HTML and our stylesheet; nothing runs. */
export const docsCsp = (): string => join({ ...BASE, "style-src": ["'self'"] })
/** /docs/interactive: Scalar from jsDelivr (it injects its own styles and fetches /openapi.json), our boot module. */
export const scalarCsp = (): string => join({
  ...BASE,
  "script-src": ["'self'", "https://cdn.jsdelivr.net"],
  "style-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
  "font-src": ["'self'", "data:", "https://cdn.jsdelivr.net", "https://fonts.scalar.com"],
  "connect-src": ["'self'"],
  "img-src": ["'self'", "data:", "https:"],
  "worker-src": ["blob:"],
})
