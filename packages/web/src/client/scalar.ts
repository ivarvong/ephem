// /docs/interactive: Scalar's API reference (a third-party script from jsDelivr, pinned by version, loaded before this module)
// pointed at /openapi.json. A module of our own instead of Scalar's inline config, so the page needs no inline script (CSP).
interface ScalarGlobal {
  createApiReference(target: string | Element, config: { url: string }): unknown
}
declare global {
  interface Window {
    Scalar?: ScalarGlobal
  }
}

const el = document.getElementById("api-reference")
if (el && window.Scalar) window.Scalar.createApiReference(el, { url: el.dataset["url"] ?? "/openapi.json" })
else if (el) el.textContent = "The interactive reference did not load; /docs is plain HTML and /openapi.json the spec."

export {}
