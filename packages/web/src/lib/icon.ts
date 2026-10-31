// The site icon: the home page's sky (near-black disk, horizon hairline, the Sun above it and the Moon). Every page inlines
// it as a data URI (zero requests; CSP img-src data:), and the Worker answers /favicon.ico with the same SVG for crawlers and
// old clients (packages/worker/src/favicon.ts).
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#05070b"/><path d="M4 22h24" stroke="#586174" stroke-width="1.5"/><circle cx="12" cy="14" r="5" fill="#ffc361"/><circle cx="23" cy="9" r="3" fill="#d9e3ff"/><circle cx="24.4" cy="8" r="2.4" fill="#05070b"/></svg>`
export const ICON_HREF = `data:image/svg+xml,${encodeURIComponent(ICON_SVG)}`
