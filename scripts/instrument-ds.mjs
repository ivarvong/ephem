#!/usr/bin/env node
// Vendor the RPN Instrument design system into packages/worker/src/instrument-ds.ts (the /instrument page, src/instrument.ts).
//
//   node scripts/instrument-ds.mjs <dir>        <dir> holds the design system's project/ files
//
// Get <dir> from the design-system artifact (https://claude.ai/artifact/GXzNsMACYszRzCoDPeG2uw): read each project/… file
// (components/bundle.css, components/bundle.js, tokens.json, fonts/*.woff2, fonts/*-OFL.txt) into <dir>/project/. Nothing is
// compiled here: bundle.css is the design system's own Tailwind 3.4.17 output (preflight off), copied verbatim except that its
// font URLs point at the Worker's immutable /assets/<sha>/ paths. tokens.css is generated from tokens.json the way the design
// system's harness does it (same variables, light + dark themes). bundle.js gets the few patches listed in PATCHES (each must
// match exactly once, or this script fails), so the Calculator reads live ephem values instead of baked ones.
// No npm dependencies: Node built-ins only. Re-run it, then `npm test` (test/instrument.test.ts checks the output).
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const dir = process.argv[2]
if (!dir) { console.error("usage: node scripts/instrument-ds.mjs <design-system dir containing project/>"); process.exit(2) }
const P = f => join(dir, "project", f)
const sha = b => createHash("sha256").update(b).digest("hex")

const FILES = [
  ["RPNDot-Regular.woff2", "font/woff2"], ["RPNDotSmall-Regular.woff2", "font/woff2"], ["SofiaSansCondensed-Legend.woff2", "font/woff2"],
  ["RPNDot-OFL.txt", "text/plain; charset=utf-8"], ["SofiaSansCondensed-OFL.txt", "text/plain; charset=utf-8"],
]
const assets = {}
for (const [name, type] of FILES) {
  const b = readFileSync(P("fonts/" + name))
  const s = sha(b).slice(0, 12)
  assets[name] = type.startsWith("font/") ? { sha: s, type, b64: b.toString("base64") } : { sha: s, type, text: b.toString("utf8") }
}
const url = name => `/assets/${assets[name].sha}/${name}`

// tokens.css from tokens.json (the design system's tools/gen_tokens_css.py, ported). Fonts are declared once, in bundle.css.
const t = JSON.parse(readFileSync(P("tokens.json"), "utf8"))
const themes = t.color.themes.map(x => x.id)
const ref = v => { const m = /^\{(.+)\}$/.exec(v); return m ? `var(--${m[1]})` : v }
const val = (tk, th) => typeof tk.value === "string" ? (th === themes[0] ? ref(tk.value) : null) : (th in tk.value ? ref(tk.value[th]) : null)
const css = []
css.push(`:root, [data-theme="${themes[0]}"] {\n` + [
  ...t.color.tokens.map(tk => `  --${tk.name}: ${val(tk, themes[0])};`),
  ...t.shadow.tokens.map(tk => `  --${tk.name}: ${typeof tk.value === "string" ? tk.value : val(tk, themes[0])};`),
].join("\n") + "\n}")
for (const th of themes.slice(1)) css.push(`[data-theme="${th}"] {\n` + t.color.tokens.filter(tk => val(tk, th)).map(tk => `  --${tk.name}: ${val(tk, th)};`).join("\n") + "\n}")
css.push(":root {\n" + [
  ...["spacing", "size", "radius"].flatMap(f => t[f].tokens.map(tk => `  --${tk.name}: ${tk.value};`)),
  ...Object.entries(t.type.families).map(([k, s]) => `  --font-${k}: ${s};`),
].join("\n") + "\n}")
const TOKENS_CSS = css.join("\n") + "\n"

let BUNDLE_CSS = readFileSync(P("components/bundle.css"), "utf8")
for (const name of FILES.map(f => f[0]).filter(n => n.endsWith(".woff2"))) {
  const from = `url("../fonts/${name}")`
  if (BUNDLE_CSS.split(from).length !== 2) throw new Error(`bundle.css: expected one ${from}`)
  BUNDLE_CSS = BUNDLE_CSS.replace(from, `url("${url(name)}")`)
}

// bundle.js patches: [why, from, to]. The design system bakes one New York instant into SKY; ephem fills RPN.sky live.
const PATCHES = [
  ["seed the stack from live values (opts.seed) instead of baked ones",
    "st.stack = [num(SKY.SUN.AZ, '°', 'AZ'), num(9.80665, 'm/s^2'), { k: 's', v: SKY.MOON.PHASE }];",
    "st.stack = [];"],
  ["a soft key whose live value has not arrived yet reports it, hardware-style, instead of pushing 0",
    "if (it.push) { push(it.push()); return; }",
    "if (it.push) { var o = it.push(); if (o.k === 'n' ? typeof o.v !== 'number' || !isFinite(o.v) : o.v == null) throw new Err(it.label, o.why || 'No Data'); push(o); return; }"],
  ["status line 2: the observer as a list, not the baked path",
    "['{ HOME EPHEM }', st.menu === 'SKY' ? st.body : '']",
    "[SKY.where || '{ HOME EPHEM }', st.menu === 'SKY' || st.menu === 'DAY' ? st.body : '']"],
  ["a DAY menu (rise, set, transit of the selected body, local hours) between SKY and CONST",
    "    var ORDER = ['MAIN', 'SKY', 'CONST'];",
    "    MENUS.DAY = function () {\n" +
    "      var d = (SKY.DAY || {})[st.body] || {};\n" +
    "      var ev = function (k, tag) { return function () { var o = num(d[k], 'h', tag); o.why = SKY.DAY ? 'No ' + tag + ' Today' : 'No Data'; return o; }; };\n" +
    "      return [\n" +
    "        { label: 'RISE', title: st.body + ' rise, local hours', push: ev('rise', 'RISE') },\n" +
    "        { label: 'SET', title: st.body + ' set, local hours', push: ev('set', 'SET') },\n" +
    "        { label: 'TRANS', title: st.body + ' transit, local hours', push: ev('transit', 'TRANS') },\n" +
    "        { label: 'NOW', title: 'Local time, hours', push: function () { return num(SKY.hours, 'h', 'NOW'); } },\n" +
    "        { label: 'SKY', dir: true, go: 'SKY' },\n" +
    "        { label: st.body === 'SUN' ? 'MOON' : 'SUN', dir: true, title: 'Switch to ' + (st.body === 'SUN' ? 'Moon' : 'Sun'), body: true }\n" +
    "      ];\n" +
    "    };\n" +
    "    var ORDER = ['MAIN', 'SKY', 'DAY', 'CONST'];"],
  ["PREV with four menus",
    "st.menu = ORDER[(ORDER.indexOf(st.menu) + 2) % 3];",
    "st.menu = ORDER[(ORDER.indexOf(st.menu) + ORDER.length - 1) % ORDER.length];"],
  ["NXT with four menus",
    "st.menu = ORDER[(ORDER.indexOf(st.menu) + 1) % 3];",
    "st.menu = ORDER[(ORDER.indexOf(st.menu) + 1) % ORDER.length];"],
  ["key cells carry their id, so the phone layout can place each one (CSS grid areas)",
    "keyEls[k.id] = cell.querySelector('button');",
    "keyEls[k.id] = cell.querySelector('button'); cell.setAttribute('data-cell', k.id);"],
  ["the page re-renders when live values arrive and seeds the stack once",
    "root.rpn = { press: press, state: snapshot };",
    "root.rpn = { press: press, state: snapshot, refresh: render, seed: function (items) { if (!st.stack.length && st.entry == null) { st.stack = items; render(); } }, num: num };"],
]
let BUNDLE_JS = readFileSync(P("components/bundle.js"), "utf8")
const jsSha = sha(BUNDLE_JS).slice(0, 12), cssSha = sha(readFileSync(P("components/bundle.css"))).slice(0, 12)
for (const [why, from, to] of PATCHES) {
  const n = BUNDLE_JS.split(from).length - 1
  if (n !== 1) throw new Error(`bundle.js patch "${why}": matched ${n} times`)
  BUNDLE_JS = BUNDLE_JS.replace(from, () => to)
}

const out = `// GENERATED by scripts/instrument-ds.mjs: do not edit. Rebuild: node scripts/instrument-ds.mjs <design-system dir> (see the script).
// The RPN Instrument design system (an original system, no maker's branding): fonts RPN Dot, RPN Dot Small (OFL) and Sofia
// Sans Condensed (OFL, subset), their licences, tokens.css (from tokens.json), components/bundle.css (Tailwind 3.4.17 output,
// font URLs → /assets/<sha12>/<file>) and components/bundle.js (patched: ${PATCHES.length} patches listed in the script).
// Sources: bundle.js sha256 ${jsSha}…, bundle.css ${cssSha}…. Served by src/instrument.ts.
export interface DsAsset { readonly sha: string; readonly type: string; readonly b64?: string; readonly text?: string }
export const ASSETS: Readonly<Record<string, DsAsset>> = ${JSON.stringify(assets)}
export const TOKENS_CSS: string = ${JSON.stringify(TOKENS_CSS)}
export const BUNDLE_CSS: string = ${JSON.stringify(BUNDLE_CSS)}
export const BUNDLE_JS: string = ${JSON.stringify(BUNDLE_JS)}
`
const target = new URL("../packages/worker/src/instrument-ds.ts", import.meta.url)
writeFileSync(target, out)
console.log(`wrote ${target.pathname}: ${out.length} bytes; ${Object.entries(assets).map(([n, a]) => `${n} ${a.sha}`).join(", ")}`)
