// `/favicon.ico` (crawlers, old clients, direct hits), answered by `favicon()` in the front door before the app: no router, no
// spans of ours, no request row. Every HTML page inlines the same icon as a data URI (@ephem/web lib/icon.ts), so a browser on
// our pages makes no icon request at all (before 2026-10-30 `/` had none, so Chrome fetched /favicon.ico after load, a 404
// through the whole Effect app with a Basin row in waitUntil: journey J20261031T000045Z-y64q).
import { ICON_SVG } from "@ephem/web/server"
export { ICON_SVG }

const ICON_HEADERS = { "content-type": "image/svg+xml", "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" }

/** GET/HEAD /favicon.ico → the icon as image/svg+xml (the type, not the extension, decides), immutable. Anything else: undefined. */
export const favicon = (request: Request): Response | undefined => {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined
  if (new URL(request.url).pathname !== "/favicon.ico") return undefined
  return new Response(request.method === "HEAD" ? null : ICON_SVG, { headers: ICON_HEADERS })
}
