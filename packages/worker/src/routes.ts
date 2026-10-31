// Every path ephem answers. One list for the request-log row (src/requestlog.ts) and the tail Worker's invocation row
// (packages/tail/src/row.ts), so the two can't drift. No imports: the tail bundles this file.
// test/requestlog.test.ts checks it against /openapi.json, /docs and the router; packages/tail/test checks the tail uses it.
/** The public API (docs/API.md): no version prefix. None collides with a page or service path below. */
export const API_PATHS: ReadonlySet<string> = new Set([
  "/position", "/track", "/day", "/crossing", "/alignment", "/alignment/search", "/sightline", "/magnetic", "/weather",
])
/** One 30-day window of POST /alignment/search: the Api entrypoint's cache unit, reached only over ctx.exports (the front
 *  door answers 404 for it), and left out of OpenAPI, /docs and MCP. */
export const SEARCH_WINDOW_PATH = "/internal/alignment-search-window"
export const ROUTES: ReadonlySet<string> = new Set([
  "/", "/rum", "/docs", "/docs/interactive", "/llms.txt", "/openapi.json", "/healthz", "/mcp",
  ...API_PATHS, SEARCH_WINDOW_PATH,
])
