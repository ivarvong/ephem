// /docs (plain HTML, readable without JavaScript) and /docs/interactive (Scalar). The Worker owns the content (one endpoint
// table, parameter lists and definitions from @ephem/api: packages/worker/src/docs.ts); these render it.
import { renderToString } from "preact-render-to-string"
import { ICON_HREF } from "../lib/icon.ts"
import { assets } from "./assets.ts"
import { SCALAR } from "./csp.ts"

export interface DocsEndpoint { readonly path: string; readonly question: string; readonly summary: string; readonly params: string; readonly example: string }
export interface DocsContent {
  readonly base: string
  readonly quickstart: ReadonlyArray<{ readonly question: string; readonly path: string }>
  readonly rules: ReadonlyArray<string>
  /** in page order; `post` is the one POST route, its example a curl line */
  readonly endpoints: ReadonlyArray<DocsEndpoint | { readonly post: true; readonly path: string; readonly question: string; readonly summary: string; readonly fields: string; readonly example: string }>
  readonly params: ReadonlyArray<readonly [string, string]>
  readonly conventions: ReadonlyArray<readonly [string, string]>
}

const Head = ({ title, css }: { readonly title: string; readonly css: boolean }) => (
  <head>
    <meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
    <link rel="icon" type="image/svg+xml" href={ICON_HREF} />
    <title>{title}</title>
    {css ? <link rel="stylesheet" href={assets().css.href} /> : null}
  </head>
)

const Docs = ({ c }: { readonly c: DocsContent }) => (
  <html lang="en">
    <Head title="ephem API" css />
    <body class="docs">
      <h1>ephem API</h1>
      <p>The Sun and Moon from JPL DE440: where they are, what they do on a day, when they reach an altitude, and where to stand so one sits on a landmark. JSON over HTTPS, CORS open, no key. Every answer is checked against an independent implementation (Skyfield for the sky, PROJ and GeographicLib for geometry, NOAA test values and pygeomag for the magnetic field) and states the conventions it used.</p>
      {c.quickstart.map(q => <><p><strong>{q.question}</strong></p><pre>curl '{c.base + q.path}'</pre></>)}
      <ul>
        <li>OpenAPI 3.1 spec: <a href="/openapi.json"><code>/openapi.json</code></a></li>
        <li>For agents: <a href="/llms.txt"><code>/llms.txt</code></a> · MCP server: <code>{c.base}/mcp</code> (Streamable HTTP; one tool per endpoint, same names and arguments)</li>
        <li>Interactive reference (needs JavaScript): <a href="/docs/interactive"><code>/docs/interactive</code></a></li>
        <li>Page: <a href="/">the live sky</a> (<code>?lat&amp;lon&amp;tz</code> override the location)</li>
      </ul>
      <h2>Rules</h2><ul>{c.rules.map(r => <li>{r}</li>)}</ul>
      <h2>Endpoints</h2><p>One question each. GET unless noted. <code>*</code> = required.</p>
      <dl>{c.endpoints.map(e => "post" in e
        ? <><dt><code>POST {e.path}</code></dt><dd><strong>{e.question}.</strong> {e.summary}<br />JSON body: <code>{e.fields}</code><br />Example: <code>{e.example}</code></dd></>
        : <><dt><code>{e.path}</code></dt><dd><strong>{e.question}</strong> {e.summary}<br />Parameters: <code>{e.params}</code><br />Example: <a href={e.example}><code>{e.example}</code></a></dd></>)}</dl>
      <h2>Parameters</h2><p>The same name means the same thing on every endpoint.</p><dl>{c.params.map(([k, v]) => <><dt><code>{k}</code></dt><dd>{v}</dd></>)}</dl>
      <h2>Conventions</h2><dl>{c.conventions.map(([k, v]) => <><dt>{k}</dt><dd>{v}</dd></>)}</dl>
    </body>
  </html>
)
export const renderDocs = (c: DocsContent): string => "<!doctype html>" + renderToString(<Docs c={c} />)

const Scalar = () => (
  <html lang="en">
    <Head title="ephem API reference" css={false} />
    <body>
      <noscript>This page needs JavaScript; <a href="/docs">/docs</a> is plain HTML and <a href="/openapi.json">/openapi.json</a> the spec.</noscript>
      <div id="api-reference" data-url="/openapi.json"></div>
      <script src={SCALAR.src} integrity={SCALAR.integrity} crossorigin="anonymous"></script>
      <script type="module" src={assets().scalar.js}></script>
    </body>
  </html>
)
export const renderScalar = (): string => "<!doctype html>" + renderToString(<Scalar />)
