---
name: mpl
description: Render zero-dependency mpljs charts to PNG and SVG and let pi inspect the PNG inline.
compatibility: Requires Node.js 24+ and Git; first use requires network access.
---

# mpl charts

`load.mjs` fetches and validates only the pinned mpl revision `c638db3d465be0c5af6c364c60e58fdf1195d51e`, then imports its TypeScript source directly with Node 24. The checkout is cached under `$XDG_CACHE_HOME/mpl/` or `$HOME/.cache/mpl/`; a warm cache works offline. `MPL_ROOT` may select an existing clean checkout, but it must match the pin and runtime digest.

Use `loadMpl()` to obtain the renderer, `design.mjs` for the restrained chart theme, and `saveFigure()` to emit a PNG plus a font-independent SVG using mpl's exported glyph-outline renderer. Never invent values: identify whether plotted data is measured, derived, theoretical, or synthetic. After rendering, ask pi to read the absolute PNG path with its `read` tool; this displays the chart inline and makes visual inspection part of the workflow.
