// The site icon. Every HTML page inlines it as a data URI (`ICON_LINK`), so a browser makes no icon request at all; before
// 2026-10-30 `/` had no <link rel=icon>, so Chrome fetched /favicon.ico after load, a 404 through the whole Effect app with a
// Basin row in waitUntil (journey J20261031T000045Z-y64q). `/favicon.ico` itself (crawlers, old clients, direct hits) is
// answered by `favicon()` in the front door before the app: no router, no spans of ours, no request row.
// Glyph: the home page's sky: near-black disk, horizon hairline, the Sun (--sun) above it and the Moon (--moon).
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#05070b"/><path d="M4 22h24" stroke="#586174" stroke-width="1.5"/><circle cx="12" cy="14" r="5" fill="#ffc361"/><circle cx="23" cy="9" r="3" fill="#d9e3ff"/><circle cx="24.4" cy="8" r="2.4" fill="#05070b"/></svg>`

/** `<link rel="icon">` for every HTML page: an inline SVG, zero requests. */
export const ICON_LINK = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(ICON_SVG)}">`

const ICON_HEADERS = { "content-type": "image/svg+xml", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" }

/** GET/HEAD /favicon.ico → the icon as image/svg+xml (the type, not the extension, decides), immutable. Anything else: undefined. */
export const favicon = (request: Request): Response | undefined => {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined
  if (new URL(request.url).pathname !== "/favicon.ico") return undefined
  return new Response(request.method === "HEAD" ? null : ICON_SVG, { headers: ICON_HEADERS })
}
