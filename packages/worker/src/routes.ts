// Every path ephem answers. One list for the request-log row (src/requestlog.ts) and the tail Worker's invocation row
// (packages/tail/src/row.ts), so the two can't drift. No imports: the tail bundles this file.
// test/requestlog.test.ts checks it against /openapi.json, /docs and the router; packages/tail/test checks the tail uses it.
export const ROUTES: ReadonlySet<string> = new Set([
  "/", "/instrument", "/docs", "/docs/interactive", "/llms.txt", "/openapi.json", "/healthz", "/mcp",
  "/v1/position", "/v1/day", "/v1/crossing", "/v1/alignment", "/v1/alignment/search", "/v1/alignment/search/window",
  "/v1/sightline", "/v1/track", "/v1/magnetic", "/v1/weather",
])
