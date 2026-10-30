// GET /instrument: the live sky as a working RPN calculator, laid out like a 48-series graphing calculator (Ivar's photo of
// two 48G+: faceplate with the LCD and six soft keys, four rows of six keys, four rows of five with the grey number block),
// built on the RPN Instrument design system's materials (tokens, fonts; vendored in src/instrument-ds.ts by
// scripts/instrument-ds.mjs). The logic is src/instrument-engine.ts (tested in test/instrument-engine.test.ts); this file is
// the markup, the CSS, the LCD renderer and the live glue.
//
// Location as the homepage (visitor(): ?lat&lon, else request.cf, else Liberty Island). First load makes two API calls,
// /v1/position (live, no `time`) and /v1/day; the magnetic declination (WMM2025) is computed here and inlined, so AZ M costs
// no request. Then one live /v1/position every 30 s while the tab is visible (at once when it becomes visible and the last
// answer is older than that), /v1/day again when the local date changes. Fonts are /assets/<sha12>/<file>, immutable.
//
// The LCD is 131 × 64 dots (the real one's pixel count). One dot is k device pixels (k integer, chosen from the case width),
// every LCD element sits at an integer dot offset, and the glass is nudged onto the device-pixel grid, so the dot faces
// render with no resampling blur; seams are a one-device-pixel grid drawn over the glass.
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import { visitor, type Visitor } from "./home.ts"
import { ASSETS, TOKENS_CSS } from "./instrument-ds.ts"
import { ENGINE_JS } from "./instrument-engine.ts"
import { declinationAt } from "./weather.ts"
import { CLIENT_TRACE_JS, documentTrace, documentTraceHeaders, traceparentMeta, type DocumentTrace } from "./clienttrace.ts"

/** The immutable URL of a vendored file (fonts, OFL licences). */
export const assetUrl = (name: string): string => `/assets/${ASSETS[name]!.sha}/${name}`

const bytes = new Map<string, Uint8Array>()   // base64 decoded once per isolate, on first use
const decode = (b64: string) => Uint8Array.from(atob(b64), c => c.charCodeAt(0))

const Assets = HttpRouter.add("GET", "/assets/:sha/:name", Effect.gen(function* () {
  const { sha, name } = yield* HttpRouter.params
  const a = name ? ASSETS[name] : undefined
  yield* Effect.annotateCurrentSpan({ "asset.name": a ? name! : "", "asset.hit": !!a && a.sha === sha })
  if (!a || a.sha !== sha) return HttpServerResponse.text("not found", { status: 404, headers: { "cache-control": "no-store" } })
  const headers = { "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" }
  if (a.text != null) return HttpServerResponse.text(a.text, { contentType: a.type, headers })
  let b = bytes.get(name!)
  if (!b) { b = decode(a.b64!); bytes.set(name!, b) }
  return HttpServerResponse.uint8Array(b, { contentType: a.type, headers })
}).pipe(Effect.withSpan("asset")))

const Page = HttpRouter.add("GET", "/instrument", req => Effect.gen(function* () {
  const tid = yield* documentTrace(req)   // on the root span; the page's fetches are its children (src/clienttrace.ts)
  return yield* Effect.gen(function* () {
    const url = Option.getOrElse(HttpServerRequest.toURL(req), () => new URL("http://localhost/instrument"))
    const v = visitor(url, (req.source as { cf?: Parameters<typeof visitor>[1] }).cf)
    yield* Effect.annotateCurrentSpan({ "home.source": v.source, "home.colo": v.colo ?? "", "home.tz": v.tz })
    return HttpServerResponse.text(instrumentPage(v, url.search, Date.now(), tid), { contentType: "text/html; charset=utf-8", headers: { "cache-control": "private, no-store", ...documentTraceHeaders(tid) } })
  }).pipe(Effect.withSpan("instrument"))
}))

export const Instrument = Layer.mergeAll(Page, Assets)

const json = (x: unknown) => JSON.stringify(x).replace(/</g, "\\u003c")
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

// ---------------------------------------------------------------------------------------------------------------------------
// The keyboard. Ids are what the engine's press() takes; `l` / `r` are the lavender / aqua shifted legends, and must match the
// engine's SHIFTED table (test/instrument-engine.test.ts checks both ways).
export interface KeyDef {
  readonly id: string; readonly cap?: string; readonly glyph?: string; readonly label: string
  readonly l?: string; readonly r?: string; readonly panel?: boolean; readonly wide?: boolean
  readonly shift?: "L" | "R"; readonly below?: string; readonly digit?: boolean
}
const k = (id: string, cap: string, label = cap, more: Partial<KeyDef> = {}): KeyDef => ({ id, cap, label, ...more })
const g = (id: string, glyph: string, label: string, more: Partial<KeyDef> = {}): KeyDef => ({ id, glyph, label, ...more })
const n = (d: string, more: Partial<KeyDef> = {}): KeyDef => ({ id: d, cap: d, label: d, digit: true, ...more })
export const ROWS6: ReadonlyArray<ReadonlyArray<KeyDef>> = [
  [k("SKY", "SKY", "SKY menu"), k("DAY", "DAY", "DAY menu"), k("CONST", "CONST", "CONST menu"), k("MAIN", "MAIN", "MAIN menu"), k("ROT", "ROT", "Rotate"), k("NXT", "NXT", "Next menu", { l: "PREV" })],
  [k("DUP", "DUP", "Duplicate"), k("OVER", "OVER"), k("DEPTH", "DEPTH"), k("LAST", "LAST", "Last arguments"), k("UNDO", "UNDO"), k("SWAP", "SWAP")],
  [k("SIN", "SIN", "Sine", { l: "ASIN" }), k("COS", "COS", "Cosine", { l: "ACOS" }), k("TAN", "TAN", "Tangent", { l: "ATAN" }),
    k("SQRT", "√x", "Square root", { l: "x^2" }), k("y^x", "y^x", "y to the x", { l: "10^x", r: "LOG" }), k("INV", "1/x", "Reciprocal", { l: "e^x", r: "LN" })],
  [k("ENTER", "ENTER", "Enter", { wide: true }), k("NEG", "+/−", "Change sign", { l: "ABS" }), k("EEX", "EEX", "Exponent", { l: "π" }),
    k("DEL", "DEL", "Delete command line", { l: "CLEAR" }), g("BACK", "back", "Backspace", { r: "DROP" })],
]
export const ROWS5: ReadonlyArray<ReadonlyArray<KeyDef>> = [
  [k("FIX", "FIX", "Display mode, FIX 2 or STD"), n("7", { panel: true, r: "SUN" }), n("8", { panel: true, r: "MOON" }), n("9", { panel: true }), g("/", "divide", "Divide")],
  [g("SHL", "shift-left", "Left shift", { shift: "L" }), n("4", { panel: true, r: "→HMS" }), n("5", { panel: true, r: "HMS→" }), n("6", { panel: true }), g("*", "times", "Multiply")],
  [g("SHR", "shift-right", "Right shift", { shift: "R", panel: true }), n("1", { panel: true }), n("2", { panel: true }), n("3", { panel: true }), g("-", "minus", "Subtract")],
  [k("ON", "ON", "Cancel", { below: "CANCEL" }), n("0"), k(".", "•", "Decimal point", { digit: true }), k("SPC", "SPC", "Space"), g("+", "plus", "Add")],
]
// The design system's key glyphs (RPN.glyphs in its bundle.js), single paths in the key's text colour.
const GLYPHS: Record<string, string> = {
  "shift-left": "M6.5 1 1 5.2l5.5 4.2V6.9h6.2v6.1h3.5V5.2q0-1.8-1.8-1.8H6.5z",
  "shift-right": "M11.5 1 17 5.2l-5.5 4.2V6.9H5.3v6.1H1.8V5.2q0-1.8 1.8-1.8h7.9z",
  back: "M7 2 1 7l6 5V8.6h10V5.4H7z",
  plus: "M7.7 1.5h2.6v4.2h4.2v2.6h-4.2v4.2H7.7V8.3H3.5V5.7h4.2z", minus: "M3.5 5.7h11v2.6h-11z",
  times: "M5 1.9 9 5.2l4-3.3 1.6 1.9L11 7l3.6 3.2-1.6 1.9L9 8.8l-4 3.3-1.6-1.9L7 7 3.4 3.8z",
  divide: "M3.5 5.7h11v2.6h-11zM9 .9a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 1 1 0-3.2zm0 9a1.6 1.6 0 1 1 0 3.2 1.6 1.6 0 1 1 0-3.2z",
}
const svg = (name: string) => `<svg viewBox="0 0 18 14" aria-hidden="true"><path d="${GLYPHS[name]}" fill="currentColor"/></svg>`
const sup = (s: string) => { const i = s.indexOf("^"); return i < 0 ? esc(s) : `${esc(s.slice(0, i))}<sup>${esc(s.slice(i + 1))}</sup>` }

const keyHtml = (d: KeyDef) => {
  const cls = ["k", d.wide && "wide", d.panel && "panel", d.digit && "digit", d.shift && "shift", d.shift === "L" && "sl", d.shift === "R" && "sr", d.below && "has-below", d.glyph && !d.shift && "glyph"].filter(Boolean).join(" ")
  const desc = [d.l && `left shift ${d.l.replace("^", " to the ")}`, d.r && `right shift ${d.r}`].filter(Boolean).join(", ")
  const face = d.shift ? `<span class="pad">${svg(d.glyph!)}</span>` : d.glyph ? svg(d.glyph) : `<span class="t">${sup(d.cap!)}</span>`
  return `<button type="button" class="${cls}" data-key="${esc(d.id)}" aria-label="${esc(d.label)}"${desc ? ` title="${esc(d.label)} (${esc(desc)})"` : ""}${d.shift ? ' aria-pressed="false"' : ""}>` +
    `<span class="lg" aria-hidden="true">${d.l ? `<span class="l">${sup(d.l)}</span>` : ""}${d.r ? `<span class="r">${sup(d.r)}</span>` : ""}</span>` +
    `<span class="cap">${face}</span>${d.below ? `<span class="below" aria-hidden="true">${esc(d.below)}</span>` : ""}</button>`
}

/** The LCD's fixed elements, every offset in dots (see LCD_CSS). The renderer only changes text and the menu's label offsets. */
const lcdHtml = () => {
  const lines = Array.from({ length: 5 }, (_, i) => `<div class="ln" style="top:calc(var(--d)*${15 + 8 * i})"></div>`).join("")
  const menu = Array.from({ length: 6 }, (_, i) => `<div class="mi" data-key="SOFT${i}" style="left:calc(var(--d)*${22 * i})"><span></span></div>`).join("")
  return `<div class="dots" id="lcd" aria-hidden="true"><div class="sm s1l"></div><div class="sm s1r"></div><div class="sm s2l"></div><div class="sm s2r"></div>` +
    `<div class="rule"></div>${lines}<div class="cur" hidden></div>${menu}<div class="seam"></div></div>`
}

const calcHtml = (v: Visitor, back: string) =>
  `<div class="calc" id="calc" role="application" aria-roledescription="calculator" aria-label="RPN calculator, live Sun and Moon for ${esc(v.place)}" tabindex="-1">` +
  `<div class="face"><div class="brand"><h1><span class="nm">ephem</span> <span class="md">INSTRUMENT</span></h1>` +
  `<div class="links"><button type="button" class="click" aria-pressed="false" title="Key click sound">CLICK</button><a class="sky" href="${esc(back)}">SKY VIEW</a></div></div>` +
  `<div class="bezel" id="bezel"><div class="glass">${lcdHtml()}</div></div>` +
  `<div class="soft" role="group" aria-label="Soft keys A to F">${"ABCDEF".split("").map((L, i) =>
    `<button type="button" class="sk" data-key="SOFT${i}" aria-label="Soft key ${L}"><span class="cap"></span><span class="al" aria-hidden="true">${L}</span></button>`).join("")}</div></div>` +
  `<div class="kb"><div class="r6">${ROWS6.flat().map(keyHtml).join("")}</div><div class="r5">${ROWS5.flat().map(keyHtml).join("")}</div></div>` +
  `<p class="vh" id="said" aria-live="polite"></p></div>`

// ---------------------------------------------------------------------------------------------------------------------------
const fontFace = (family: string, file: string, display: string, weight = "400") =>
  `@font-face{font-family:"${family}";src:url("${assetUrl(file)}") format("woff2");font-weight:${weight};font-display:${display}}`

/**
 * Sizes come from four variables the layout script sets (defaults are the 390 × 844 phone): --w case width, --p key-row
 * pitch (≥ 44 px: every key's hit area is its whole cell, legend included), --d one LCD dot (an integer number of device
 * pixels), --px one device pixel. Visible caps are smaller than their cells (soft keys most of all, as on the hardware).
 */
const PAGE_CSS = `
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%;touch-action:manipulation}
html,body{margin:0;background:var(--surface);color:var(--ink)}
body{font:400 15px/22px var(--font-legend)}
:root{--w:358px;--p:52px;--d:2.3333px;--px:.3333px;--gv:12px;--fs-k:clamp(13px,calc(var(--w)*.042),17px);--fs-l:clamp(10px,calc(var(--w)*.031),13px)}
.stage{display:flex;flex-direction:column;align-items:center}
.well{min-height:100vh;min-height:100dvh;width:100%;display:flex;align-items:center;justify-content:center;padding:var(--gv) 0}
.help{width:var(--w);max-width:calc(100vw - 32px);padding:8px 0 32px;font-size:14px;line-height:20px;color:var(--ink-muted)}
.help h2{font:700 12px/16px var(--font-legend);letter-spacing:.12em;text-transform:uppercase;color:var(--ink);margin:16px 0 6px}
.help p{margin:0 0 8px}.help kbd{font:700 13px/1 var(--font-legend);color:var(--ink)}
.help dl{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:0}.help dt{font-weight:700;color:var(--ink);white-space:nowrap}.help dd{margin:0}
.help a{color:var(--ink);text-underline-offset:2px}
.help a:focus-visible{outline:none;box-shadow:var(--shadow-focus);border-radius:2px}
@media (min-width:900px) and (min-height:620px){
  .stage{flex-direction:row;justify-content:center;align-items:center;gap:56px;min-height:100vh;min-height:100dvh}
  .well{min-height:0;width:auto}.help{width:300px;padding:0}
}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;margin:0}

/* the case: rim, the lighter faceplate (brand, LCD, soft keys), then the keyboard */
.calc{position:relative;flex:none;width:var(--w);border:3px solid var(--case-rim);border-radius:calc(var(--w)*.05);background-color:var(--case-body);
  background-image:linear-gradient(180deg,var(--light-case-top),transparent 45%);box-shadow:var(--shadow-case);padding:0 0 calc(var(--p)*.22);
  user-select:none;-webkit-user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;touch-action:manipulation;outline:none}
.face{background-color:var(--case-upper);background-image:linear-gradient(180deg,var(--light-case-top),transparent 70%);
  border-radius:calc(var(--w)*.05 - 3px) calc(var(--w)*.05 - 3px) 0 0;padding:0 calc(var(--w)*.026) 2px;box-shadow:0 1px 0 rgba(0,0,0,.45),0 2px 0 rgba(255,255,255,.04)}
.brand{display:flex;justify-content:space-between;align-items:center;height:28px;padding:0 2px}
.brand h1{margin:0;font:700 11px/1 var(--font-legend);letter-spacing:.14em;color:var(--key-legend)}
.brand .nm{font-size:13px;letter-spacing:.06em;text-transform:none}.brand .md{opacity:.75}
.links{display:flex;gap:14px;align-items:center}
.links a,.click{position:relative;font:800 10px/1 var(--font-legend);letter-spacing:.1em;color:var(--legend-right);text-decoration:none;background:none;border:0;padding:2px 0;margin:0;cursor:pointer;border-radius:2px}
.links a::before,.click::before{content:"";position:absolute;inset:-14px -8px}
.click{color:var(--legend-alpha);display:inline-flex;gap:5px;align-items:center}
.click::after{content:"";order:-1;width:6px;height:6px;border-radius:1px;background:var(--key-side);box-shadow:inset 0 0 0 1px var(--legend-alpha)}
.click[aria-pressed="true"]::after{background:var(--legend-right);box-shadow:0 0 6px var(--legend-right)}
.links a:focus-visible,.click:focus-visible{outline:none;box-shadow:var(--shadow-focus)}
.links a:hover{text-decoration:underline}

/* the window: bezel > glass (lcd-margin) > 131 × 64 dots */
.bezel{width:max-content;margin:0 auto;padding:7px;border-radius:8px;background-color:var(--bezel);
  background-image:linear-gradient(180deg,var(--shade-bezel) 0,transparent 28%,transparent 70%,var(--light-bezel-lit) 100%)}
.glass{position:relative;padding:calc(var(--d)*2);border-radius:3px;background-color:var(--lcd-margin);box-shadow:var(--shadow-glass);overflow:hidden}
.glass::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
  background:linear-gradient(116deg,var(--light-lcd-glare) 0%,transparent 32%),radial-gradient(130% 150% at 50% 42%,transparent 54%,var(--shade-lcd-vignette) 100%)}
.dots{position:relative;width:calc(var(--d)*131);height:calc(var(--d)*64);background:var(--lcd-ghost);color:var(--lcd-ink);overflow:hidden;
  font-variant-ligatures:none;font-kerning:none;-webkit-font-smoothing:antialiased;text-rendering:optimizeSpeed}
.dots>div{position:absolute;white-space:pre}
.ln{left:calc(var(--d)*3);font:400 calc(var(--d)*10)/calc(var(--d)*10) var(--font-dot);text-shadow:var(--px) var(--px) 0 var(--shade-lcd-dot)}
.sm{font:400 calc(var(--d)*10)/calc(var(--d)*10) var(--font-dot-small);text-shadow:var(--px) var(--px) 0 var(--shade-lcd-dot)}
.s1l,.s2l{left:calc(var(--d)*3)}.s1r,.s2r{right:calc(var(--d)*2)}.s1l,.s1r{top:calc(var(--d)*-2)}.s2l,.s2r{top:calc(var(--d)*5)}
.rule{left:0;top:calc(var(--d)*14);width:100%;height:var(--d);background:var(--lcd-ink)}
.cur{width:calc(var(--d)*5);height:calc(var(--d)*7);background:var(--lcd-ink);animation:blink 1.1s steps(1) infinite}
.cur[hidden]{display:none}
@keyframes blink{50%{opacity:0}}
.mi{top:calc(var(--d)*56);width:calc(var(--d)*21);height:calc(var(--d)*7);background:var(--lcd-ink);color:var(--lcd-ink-on);cursor:pointer}
.mi>span{position:absolute;top:calc(var(--d)*-2);left:0;font:400 calc(var(--d)*10)/calc(var(--d)*10) var(--font-dot-small);white-space:pre}
.mi.dir::before{content:"";position:absolute;left:0;top:calc(var(--d)*-1);width:calc(var(--d)*8);height:var(--d);background:var(--lcd-ink)}
.mi.down{background:transparent;color:var(--lcd-ink);box-shadow:inset 0 0 0 var(--d) var(--lcd-ink)}
.seam{inset:0;pointer-events:none;opacity:.5;background-image:linear-gradient(90deg,var(--lcd-panel) var(--px),transparent var(--px)),linear-gradient(180deg,var(--lcd-panel) var(--px),transparent var(--px));background-size:var(--d) var(--d)}

/* soft keys A–F: small flat off-white pads in a black surround, the letter at the bottom right; the hit area is the cell */
.soft{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));margin:calc(var(--p)*.08) 0 0}
button{font:inherit;color:inherit;margin:0}
.sk,.k{position:relative;display:flex;flex-direction:column;align-items:center;background:none;border:0;padding:0;cursor:pointer;-webkit-tap-highlight-color:transparent;touch-action:manipulation;-webkit-touch-callout:none}
.sk{height:max(44px,calc(var(--p)*.86));justify-content:center}
.sk .cap{position:relative;width:70%;height:clamp(16px,calc(var(--p)*.4),24px);border-radius:5px;background:var(--key-cap);box-shadow:var(--shadow-key);transition:transform 70ms cubic-bezier(.2,.7,.3,1),box-shadow 70ms cubic-bezier(.2,.7,.3,1)}
.sk .cap::after{content:"";position:absolute;inset:2px 3px 4px;border-radius:3px;background-color:var(--softkey);background-image:linear-gradient(180deg,rgba(255,255,255,.35),transparent 60%)}
.sk .al{position:absolute;left:calc(85% + 1px);bottom:calc(50% - clamp(16px,calc(var(--p)*.4),24px)/2 - 2px);font:800 calc(var(--fs-l)*.9)/1 var(--font-legend);color:var(--key-legend)}

/* the keyboard: four rows of six, four of five */
.kb{padding:calc(var(--p)*.1) calc(var(--w)*.018) 0}
.r6,.r5{display:grid}.r6{grid-template-columns:repeat(6,minmax(0,1fr))}.r5{grid-template-columns:repeat(5,minmax(0,1fr))}
.k{height:var(--p);justify-content:flex-end;padding-bottom:calc(var(--p)*.1)}
.k .lg{display:flex;gap:.3em;justify-content:center;height:calc(var(--fs-l)*1.05);margin-bottom:max(2px,calc(var(--p)*.05));font:700 var(--fs-l)/1 var(--font-legend);white-space:nowrap;letter-spacing:.01em}
.lg .l{color:var(--legend-left)}.lg .r{color:var(--legend-right)}
.k sup{font-size:.68em;line-height:0;vertical-align:.5em;margin-left:.04em}
.k .cap{position:relative;display:flex;align-items:center;justify-content:center;width:82%;height:max(20px,calc(var(--p) - var(--fs-l)*1.05 - var(--p)*.2 - 2px));
  border-radius:calc(var(--p)*.13);background-color:var(--key-cap);background-image:linear-gradient(180deg,var(--light-key-sheen) 0%,transparent 55%);box-shadow:var(--shadow-key);
  color:var(--key-legend);font:700 var(--fs-k)/1 var(--font-legend);padding-bottom:2px;transition:transform 70ms cubic-bezier(.2,.7,.3,1),box-shadow 70ms cubic-bezier(.2,.7,.3,1)}
.k .cap::before,.sk .cap::before{content:"";position:absolute;inset:2px 3px 5px;pointer-events:none;border-radius:calc(var(--p)*.13 - 2px);
  background:linear-gradient(180deg,var(--light-key-sheen),transparent 60%);box-shadow:inset 0 1px 0 var(--light-key-top)}
.k .t{position:relative}
.r5 .k .cap{width:80%}.k.digit .cap{font-size:calc(var(--fs-k)*1.2);font-weight:600}
.k.wide{grid-column:span 2}.k.wide .cap{width:91%;letter-spacing:.08em;font-size:calc(var(--fs-k)*1.1)}
.k svg{position:relative;width:calc(var(--fs-k)*1.15);height:calc(var(--fs-k)*.9);display:block}
.k.panel{background:var(--numpad-panel);box-shadow:inset 0 0 0 2px var(--case-body)}
.k.shift .pad{position:absolute;inset:3px 5px 5px;display:flex;align-items:center;justify-content:center;border-radius:3px;color:var(--shift-glyph);
  background-image:linear-gradient(180deg,var(--light-key-top),transparent 65%);transition:box-shadow 120ms ease,filter 120ms ease}
.k.sl .pad{background-color:var(--shift-left)}.k.sr .pad{background-color:var(--shift-right)}
.k.shift svg{width:calc(var(--fs-k)*1.3);height:calc(var(--fs-k)*1)}
.k.shift[aria-pressed="true"] .pad{filter:brightness(1.12) saturate(1.15);box-shadow:0 0 0 1px rgba(255,255,255,.35),0 0 12px 1px var(--glow)}
.k.sl{--glow:var(--shift-left)}.k.sr{--glow:var(--shift-right)}
.k.has-below{padding-bottom:calc(var(--fs-l)*1.2)}
.k .below{position:absolute;bottom:calc(var(--p)*.04);font:800 calc(var(--fs-l)*.95)/1 var(--font-legend);letter-spacing:.04em;color:var(--key-legend)}
.is-shl .lg .l{color:var(--legend-left-lit);text-shadow:0 0 6px var(--shift-left),0 0 1px var(--shift-left)}
.is-shr .lg .r{color:var(--legend-right-lit);text-shadow:0 0 6px var(--shift-right),0 0 1px var(--shift-right)}
.k.down .cap,.sk.down .cap{transform:translateY(2px);box-shadow:var(--shadow-key-pressed)}
.k:focus-visible,.sk:focus-visible{outline:none}
.k:focus-visible .cap,.sk:focus-visible .cap{box-shadow:var(--shadow-key),var(--shadow-focus);z-index:1}
@media (prefers-reduced-motion:reduce){
  .k .cap,.sk .cap,.k.shift .pad{transition:none}
  .k.down .cap,.sk.down .cap{transform:none}
  .cur{animation:none}
}
@media (forced-colors:active){.k .cap,.sk .cap{border:1px solid ButtonText}}
`

/**
 * Layout, then the LCD renderer, then input. Runs synchronously after the markup (before first paint), so there is no
 * layout shift. window.__instrument records timings and the computed geometry for scripts.
 */
export const VIEW_JS = String.raw`
(function () {
"use strict";
var S = window.__instrument = { t0: performance.now(), dataAt: null, dayAt: null, calls: 0, errors: 0, geo: null };
var root = document.documentElement, calc = document.getElementById("calc"), bezel = document.getElementById("bezel"), lcd = document.getElementById("lcd");
// ---- layout: case width, key pitch, an integer-device-pixel dot, the glass on the pixel grid ----
function layout() {
  var dpr = window.devicePixelRatio || 1, vw = root.clientWidth, vh = window.innerHeight, wide = vw >= 900 && vh >= 620;
  var gh = vw <= 420 ? 16 : 24, gv = vh <= 700 ? 8 : 12;
  var w = Math.min(vw - 2 * gh, 440);
  if ((vw - w) % 2) w -= 1;                                  // centred at an integer offset
  var chrome = 2 * (3 + Math.round(w * 0.026) + 7);           // case border + faceplate padding + bezel, both sides
  var dev = Math.max(2, Math.floor((w - chrome) / 135 * dpr)); // 131 dots + the 2-dot glass margin each side
  var d = Math.min(dev, Math.ceil(3 * dpr)) / dpr;
  root.style.setProperty("--w", w + "px"); root.style.setProperty("--d", d + "px"); root.style.setProperty("--px", 1 / dpr + "px"); root.style.setProperty("--gv", gv + "px");
  root.style.setProperty("--p", "52px");
  var fixed = calc.offsetHeight - 8 * 52;                     // everything that is not the eight key rows
  var p = Math.floor(Math.max(44, Math.min(w * 0.155, 62, (vh - 2 * gv - fixed) / 8)));
  root.style.setProperty("--p", p + "px");
  bezel.style.transform = "";
  var r = lcd.getBoundingClientRect(), dx = Math.round(r.left * dpr) / dpr - r.left, dy = Math.round(r.top * dpr) / dpr - r.top;
  if (dx || dy) bezel.style.transform = "translate(" + dx + "px," + dy + "px)";
  r = lcd.getBoundingClientRect();
  S.geo = { dpr: dpr, w: w, d: d, dotDevicePx: d * dpr, pitch: p, lcd: [r.left, r.top, r.width, r.height], lcdDevice: [r.left * dpr, r.top * dpr], fits: calc.offsetHeight + 2 * gv <= vh, wide: wide };
}
layout();
var lastW = root.clientWidth, lastH = window.innerHeight, raf = 0;
window.addEventListener("resize", function () {
  if (root.clientWidth === lastW && Math.abs(window.innerHeight - lastH) < 2) return;
  lastW = root.clientWidth; lastH = window.innerHeight;
  cancelAnimationFrame(raf); raf = requestAnimationFrame(layout);
});
if (window.matchMedia) { try { matchMedia("(resolution: " + (window.devicePixelRatio || 1) + "dppx)").addEventListener("change", layout); } catch (e) {} }

// ---- the engine, the renderer ----
var sky = window.__sky = { SUN: {}, MOON: {}, DAY: null, TIME: "--:--", HOURS: null, WHERE: "{ HOME }", MAGDEC: null };
var E = RPNEngine.create({ sky: function () { if (window.__hours) sky.HOURS = window.__hours(); return sky; } });
var Q = function (s) { return lcd.querySelector(s); };
var stEls = [Q(".s1l"), Q(".s1r"), Q(".s2l"), Q(".s2r")], lnEls = lcd.querySelectorAll(".ln"), miEls = lcd.querySelectorAll(".mi"), cur = Q(".cur");
var said = document.getElementById("said"), keys = {};
Array.prototype.forEach.call(calc.querySelectorAll("button[data-key]"), function (b) { keys[b.getAttribute("data-key")] = b; });
var softs = calc.querySelectorAll(".sk");
function setText(el, t) { if (el.textContent !== t) el.textContent = t; }
var lastSaid = "";
function render() {
  var v = E.view();
  setText(stEls[0], v.status[0][0]); setText(stEls[1], v.status[0][1]); setText(stEls[2], v.status[1][0]); setText(stEls[3], v.status[1][1]);
  for (var i = 0; i < lnEls.length; i++) setText(lnEls[i], v.lines[i] || "");
  if (v.entryLine >= 0) {
    cur.hidden = false;
    cur.style.top = "calc(var(--d)*" + (16 + 8 * v.entryLine) + ")"; cur.style.left = "calc(var(--d)*" + (3 + 6 * v.cursorCol) + ")";
  } else cur.hidden = true;
  v.menu.forEach(function (m, i) {
    var el = miEls[i], sp = el.firstChild, lab = m.label;
    setText(sp, lab);
    sp.style.left = "calc(var(--d)*" + Math.max(0, Math.floor((RPNEngine.CELL_DOTS - RPNEngine.smallWidth(lab)) / 2)) + ")";
    el.classList.toggle("dir", m.dir);
    softs[i].setAttribute("aria-label", "Soft key " + "ABCDEF"[i] + (lab ? ": " + lab + (m.dir ? " menu" : "") : ", unassigned"));
  });
  calc.classList.toggle("is-shl", v.shift === "L"); calc.classList.toggle("is-shr", v.shift === "R");
  keys.SHL.setAttribute("aria-pressed", String(v.shift === "L")); keys.SHR.setAttribute("aria-pressed", String(v.shift === "R"));
  var t = v.err ? v.status[0][0] + " " + v.status[1][0] : v.entryLine >= 0 ? "Command line " + v.lines[v.entryLine].trim() : "Level 1 " + (v.lines[v.lines.length - 1].slice(2).trim() || "empty");
  if (t !== lastSaid) { lastSaid = t; said.textContent = t; }
}
window.__render = render;
window.__engine = E;

// ---- feel: press animation, synthesized click (opt-in), haptics where the platform has them ----
var audio = null, sound = false;
function click() {
  if (!sound) return;
  try {
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    var n = Math.floor(audio.sampleRate * 0.012), buf = audio.createBuffer(1, n, audio.sampleRate), d = buf.getChannelData(0);
    for (var i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 6);
    var src = audio.createBufferSource(), bp = audio.createBiquadFilter(), g = audio.createGain();
    bp.type = "bandpass"; bp.frequency.value = 2600; bp.Q.value = 1.4; g.gain.value = 0.35;
    src.buffer = buf; src.connect(bp); bp.connect(g); g.connect(audio.destination); src.start();
  } catch (e) { /* no audio: stay silent */ }
}
// Android: navigator.vibrate. iOS Safari (18+) has no vibrate, but toggling an <input type=checkbox switch> through its label
// inside a user gesture plays the system's selection haptic.
var haptic = (function () {
  if (navigator.vibrate) return function (pattern) { try { navigator.vibrate(pattern); } catch (e) {} };
  var ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!ios) return function () {};
  var l = document.createElement("label"), i = document.createElement("input");
  i.type = "checkbox"; i.setAttribute("switch", ""); i.tabIndex = -1; l.appendChild(i); l.setAttribute("aria-hidden", "true");
  l.style.cssText = "position:fixed;left:-100px;top:0;width:1px;height:1px;opacity:0;pointer-events:none";
  document.body.appendChild(l);
  return function () { l.click(); };
})();
var clickBtn = calc.querySelector(".click");
clickBtn.addEventListener("click", function () { sound = !sound; clickBtn.setAttribute("aria-pressed", String(sound)); click(); });

function down(el, ms) {
  if (!el) return; el.classList.add("down");
  var m = el.getAttribute("data-key"), mi = /^SOFT/.test(m) ? lcd.querySelector('.mi[data-key="' + m + '"]') : null;
  if (mi) mi.classList.add("down");
  clearTimeout(el.__t);
  if (ms) el.__t = setTimeout(function () { up(el); }, ms);
}
function up(el) {
  el.classList.remove("down");
  var m = el.getAttribute("data-key"), mi = /^SOFT/.test(m) ? lcd.querySelector('.mi[data-key="' + m + '"]') : null;
  if (mi) mi.classList.remove("down");
}
function press(id, touch) {
  click();
  E.press(id); render();
  var v = E.view();
  if (touch) haptic(v.err ? [12, 60, 12] : 8);
}
// Pointer: act on press (pointerdown), like the hardware; no 300 ms delay, no double-tap zoom (touch-action), no callout
// or selection on long press. A cap stays down at least 70 ms so a quick tap still shows travel.
var held = null, heldAt = 0;
calc.addEventListener("pointerdown", function (e) {
  if (e.button !== 0) return;
  var el = e.target.closest("[data-key]"); if (!el) return;
  var id = el.getAttribute("data-key"), btn = keys[id] && keys[id].classList.contains("sk") ? keys[id] : el.tagName === "BUTTON" ? el : keys[id];
  if (!btn) return;
  e.preventDefault();                                        // no focus from a pointer, no text selection, no emulated mouse events
  held = btn; heldAt = performance.now(); down(btn);
  press(id, e.pointerType === "touch" || e.pointerType === "pen");
});
function release() {
  if (!held) return;
  var el = held; held = null;
  var left = 70 - (performance.now() - heldAt);
  if (left > 0) setTimeout(function () { up(el); }, left); else up(el);
}
["pointerup", "pointercancel", "lostpointercapture"].forEach(function (t) { window.addEventListener(t, release); });
calc.addEventListener("contextmenu", function (e) { e.preventDefault(); });
// Keyboard activation of a focused key (Tab to it, Enter or Space): click with detail 0. Pointer presses never reach here.
calc.addEventListener("click", function (e) {
  if (e.detail !== 0) return;
  var el = e.target.closest("button[data-key]"); if (!el) return;
  down(el, 90); press(el.getAttribute("data-key"), false);
});
// Typing anywhere drives the instrument. The map is listed in the help below the calculator.
var KEYMAP = { Enter: "ENTER", Backspace: "BACK", Delete: "DEL", Escape: "ON", " ": "SPC", "+": "+", "-": "-", "*": "*", "/": "/", ".": ".", ",": ".",
  "^": "y^x", e: "EEX", E: "EEX", n: "NEG", _: "NEG", s: "SWAP", d: "DUP", o: "OVER", r: "ROT", l: "LAST", u: "UNDO", f: "FIX", q: "SQRT", i: "INV",
  "[": "SHL", "]": "SHR", PageDown: "NXT", PageUp: "PREV" };
document.addEventListener("keydown", function (e) {
  if (e.defaultPrevented || e.altKey) return;
  var a = document.activeElement;
  if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z") && !e.shiftKey) { e.preventDefault(); down(keys.UNDO, 90); press("UNDO"); return; }
  if (e.metaKey || e.ctrlKey) return;
  if (a && (a.tagName === "A" || (a.tagName === "BUTTON" && !a.hasAttribute("data-key"))) && (e.key === "Enter" || e.key === " ")) return;
  if (a && a.hasAttribute && a.hasAttribute("data-key") && (e.key === "Enter" || e.key === " ")) return;   // the focused key presses itself
  var id = /^[0-9]$/.test(e.key) ? e.key : /^F[1-6]$/.test(e.key) ? "SOFT" + (+e.key.slice(1) - 1) : KEYMAP[e.key];
  if (!id) return;
  e.preventDefault();
  down(id === "PREV" ? keys.NXT : keys[id], 90);
  press(id, false);
});
render();
})();
`

/**
 * The live glue: fills the engine's sky from /v1/position and /v1/day, seeds the stack once, keeps the clock on the minute.
 * Values are stored at full precision (the display rounds to FIX 2): azimuth true and magnetic (WMM2025 declination,
 * inlined by the server), geometric altitude (the homepage's "Altitude"), declination, distance; event times as local
 * decimal hours, so SET RISE − is the day's length.
 */
export const GLUE_JS = String.raw`
(function () {
"use strict";
var S = window.__instrument, sky = window.__sky, E = window.__engine, render = window.__render, N = RPNEngine.num;
sky.MAGDEC = LOC.magdec;
sky.WHERE = "{ " + RPNEngine.fmtNum(LOC.lat, "FIX") + " " + RPNEngine.fmtNum(LOC.lon, "FIX") + " }";
var tf = new Intl.DateTimeFormat("en-GB", { timeZone: LOC.tz, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
var df = new Intl.DateTimeFormat("en-CA", { timeZone: LOC.tz });
function localHours(ms) { var p = tf.format(new Date(ms)).split(":").map(Number); return (p[0] % 24) + p[1] / 60 + p[2] / 3600; }
window.__hours = function () { return localHours(Date.now()); };
var linkDown = false;
function clock() { sky.TIME = linkDown ? "NO LINK" : tf.format(new Date()).slice(0, 5); }
function q(extra) { var o = { lat: LOC.lat.toFixed(5), lon: LOC.lon.toFixed(5) }; for (var k in extra) o[k] = extra[k]; return new URLSearchParams(o).toString(); }
function get(path, extra) {
  S.calls++;
  return __tfetch(path + "?" + q(extra)).then(function (r) { return r.json().then(function (b) { if (!r.ok) throw new Error(b && b.message || "HTTP " + r.status); return b; }); });
}
function body(b) { return { AZ: b.azimuth, ALT: b.altitude, DECL: b.declination, DIST: b.distanceKm }; }
var seeded = false, posAt = 0;
function position() {
  return get("/v1/position").then(function (p) {
    posAt = Date.now(); linkDown = false;
    sky.SUN = body(p.sun); sky.MOON = body(p.moon);
    sky.MOON.PHASE = p.moon.phase.name.toUpperCase(); sky.MOON.ILLUM = p.moon.phase.illuminatedFraction * 100;
    sky.TIME_UTC = p.time.utc; clock();
    if (!seeded) {
      seeded = true;
      E.seed([N(RPNEngine.wrap360(sky.SUN.AZ), "°", "AZ T"), N(RPNEngine.wrap360(sky.SUN.AZ - sky.MAGDEC), "°", "AZ M"), N(sky.SUN.ALT, "°", "ALT"), RPNEngine.str(sky.MOON.PHASE)]);
    }
    render();
    if (S.dataAt == null) { S.dataAt = performance.now(); if (performance.mark) performance.mark("ephem:data"); }
  });
}
var dayFor = null;
function day() {
  var d = df.format(new Date());
  if (d === dayFor) return Promise.resolve();
  dayFor = d;
  return get("/v1/day", { date: d, tz: LOC.tz }).then(function (r) {
    var out = { SUN: {}, MOON: {} };
    r.events.forEach(function (e) {
      var B = e.body === "sun" ? out.SUN : e.body === "moon" ? out.MOON : null;
      if (B && (e.kind === "rise" || e.kind === "set" || e.kind === "transit") && B[e.kind] == null) B[e.kind] = localHours(Date.parse(e.time));
    });
    sky.DAY = out; render();
    if (S.dayAt == null) S.dayAt = performance.now();
  }, function (e) { dayFor = null; throw e; });
}
function fail(e) { S.errors++; linkDown = true; clock(); render(); if (window.console) console.warn("instrument:", e && e.message || e); }
function refresh() { position().catch(fail); day().catch(fail); }
refresh();
setInterval(function () { if (document.visibilityState === "visible") refresh(); }, 30000);
document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible" && Date.now() - posAt > 30000) refresh(); });
// the status clock turns over on the minute, not up to 15 s late
(function tick() { clock(); render(); setTimeout(tick, 60000 - Date.now() % 60000 + 30); })();
})();
`

const HELP = (v: Visitor, magdec: number) => `<aside class="help" aria-label="How to use the instrument">
<h2>Live for ${esc(v.place)}</h2>
<p>The Sun and Moon from JPL DE440, refreshed every 30 s. The soft keys under the glass push values onto the stack; the
stack really computes (try <b>DAY</b>, then SET, RISE, <kbd>−</kbd> for the day's length in hours, and <b>→HMS</b> to read it as h.mmss).</p>
<dl>
<dt>AZ T / AZ M</dt><dd>azimuth, true and magnetic (WMM2025, declination ${magdec >= 0 ? "" : "−"}${Math.abs(magdec).toFixed(2)}°)</dd>
<dt>ALT</dt><dd>altitude (geometric), DECL declination, DIST distance</dd>
<dt>FIX</dt><dd>two decimals (default) or STD, 12 digits</dd>
</dl>
<h2>Keyboard</h2>
<dl>
<dt><kbd>0–9 . E</kbd></dt><dd>number, exponent; <kbd>n</kbd> changes sign</dd>
<dt><kbd>Enter</kbd> <kbd>Space</kbd></dt><dd>enter; separate numbers</dd>
<dt><kbd>+ − * / ^</kbd></dt><dd>arithmetic, y<sup>x</sup></dd>
<dt><kbd>F1</kbd>–<kbd>F6</kbd></dt><dd>soft keys A–F; <kbd>PgDn</kbd> <kbd>PgUp</kbd> next, previous menu</dd>
<dt><kbd>⌫</kbd> <kbd>Del</kbd> <kbd>Esc</kbd></dt><dd>backspace or drop; delete the command line; cancel</dd>
<dt><kbd>s d o r</kbd></dt><dd>swap, dup, over, rot; <kbd>l</kbd> last arguments, <kbd>u</kbd> or <kbd>⌘Z</kbd> undo</dd>
<dt><kbd>[</kbd> <kbd>]</kbd></dt><dd>left, right shift; <kbd>q</kbd> √x, <kbd>i</kbd> 1/x, <kbd>f</kbd> FIX</dd>
</dl>
<p style="margin-top:12px">Fonts: <a href="${assetUrl("RPNDot-OFL.txt")}">RPN Dot</a> and <a href="${assetUrl("SofiaSansCondensed-OFL.txt")}">Sofia Sans</a> (OFL). <a href="/docs">The API</a>.</p>
</aside>`

export const instrumentPage = (v: Visitor, search = "", now = Date.now(), trace?: DocumentTrace): string => {
  const fonts = Object.keys(ASSETS).filter(f => f.endsWith(".woff2"))
  const back = "/" + (search && /[?&]lat=/.test(search) ? search : "")
  const magdec = declinationAt(v.lat, v.lon, now).declination
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
${traceparentMeta(trace)}
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>ephem · instrument · ${esc(v.city)}</title>
<meta name="description" content="The live Sun and Moon from JPL DE440 on a working RPN calculator: the soft keys push real values onto the stack.">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#121416" media="(prefers-color-scheme: dark)"><meta name="theme-color" content="#eae9e6" media="(prefers-color-scheme: light)">
<link rel="icon" href="data:,">
${fonts.map(f => `<link rel="preload" href="${assetUrl(f)}" as="font" type="font/woff2" crossorigin>`).join("\n")}
<script>(function(){var m=matchMedia("(prefers-color-scheme: dark)");var s=function(){document.documentElement.setAttribute("data-theme",m.matches?"dark":"light")};s();m.addEventListener&&m.addEventListener("change",s)})();</script>
<style>${fontFace("RPN Dot", "RPNDot-Regular.woff2", "block")}${fontFace("RPN Dot Small", "RPNDotSmall-Regular.woff2", "block")}${fontFace("Sofia Sans Condensed", "SofiaSansCondensed-Legend.woff2", "swap", "400 800")}</style>
<style>${TOKENS_CSS}</style>
<style>${PAGE_CSS}</style>
</head><body>
<main class="stage"><div class="well">${calcHtml(v, back)}</div>${HELP(v, magdec)}</main>
<noscript><p style="text-align:center">The instrument needs JavaScript. <a href="${esc(back)}">The sky view</a> and <a href="/docs">the API</a> work without it.</p></noscript>
<script>${ENGINE_JS}</script>
<script>${VIEW_JS}</script>
<script>const LOC = ${json({ lat: v.lat, lon: v.lon, tz: v.tz, place: v.place, magdec })};</script>
<script>${CLIENT_TRACE_JS}${GLUE_JS}</script>
</body></html>`
}
