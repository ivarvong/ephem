// @ephem/web/server: what the Worker renders pages with. The Worker stays the server (routing, data, tracing, logs); this
// package owns every byte of HTML, CSS and client JS.
export {
  renderHomeHead,
  renderHomeBody,
  renderHomeStatic,
  answersOf,
  bootOf,
  type Embeds,
  type HeadTag,
  type HomeHead,
} from "./home.tsx"
export { renderDocs, renderScalar, type DocsContent, type DocsEndpoint } from "./docs.tsx"
export { homeCsp, docsCsp, scalarCsp, SCALAR } from "./csp.ts"
export { assets, setDevAssets, coreId, type Assets } from "./assets.ts"
export { jsonText } from "./json.ts"
export { ICON_SVG, ICON_HREF } from "../lib/icon.ts"
export { coordQuery, trackQuery, dayQuery, localDate, nextDate } from "../lib/time.ts"
export type { Visitor } from "../lib/types.ts"
