// Load pages in headless Chrome (our CDP client) and print every console message, exception, CSP violation and failed
// request, plus the CSP header it was served with. Exit 1 if any page logged an error or a violation.
//   node --experimental-strip-types scripts/obs/page-console.ts <url>… [--wait ms] [--eval <expr>] [--width 390]
import { launch } from "./cdp/cdp.ts"
import { emulate, evaluate, navigate } from "./cdp/page.ts"

const args = process.argv.slice(2), opt = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : undefined }
const wait = Number(opt("--wait") ?? 4000), expr = opt("--eval"), width = Number(opt("--width") ?? 390)
if (!args.length) { console.error("usage: page-console.ts <url>… [--wait ms] [--eval expr] [--width px]"); process.exit(2) }
const b = await launch()
let bad = 0
try {
  for (const url of args) {
    const p = await b.newPage(), lines: string[] = []
    await p.send("Page.enable"); await p.send("Runtime.enable"); await p.send("Log.enable"); await p.send("Network.enable")
    await emulate(p, { name: "x", width, height: 844, dpr: 2, mobile: width < 1000, touch: width < 1000 })
    let csp = ""
    p.on("Network.responseReceived", (e: any) => { if (e.type === "Document") csp = e.response.headers["content-security-policy"] ?? "(none)"; if (e.response.status >= 400) lines.push(`HTTP ${e.response.status} ${e.response.url}`) })
    p.on("Network.loadingFailed", (e: any) => { if (!/ERR_ABORTED/.test(e.errorText)) lines.push(`request failed ${e.errorText} ${e.blockedReason ?? ""}`) })
    p.on("Runtime.consoleAPICalled", (e: any) => lines.push(`console.${e.type}: ${e.args.map((a: any) => a.value ?? a.description ?? "").join(" ")}`))
    p.on("Runtime.exceptionThrown", (e: any) => lines.push(`exception: ${e.exceptionDetails.exception?.description ?? e.exceptionDetails.text}`))
    p.on("Log.entryAdded", (e: any) => lines.push(`log.${e.entry.level} [${e.entry.source}]: ${e.entry.text}`))
    await navigate(p, url)
    await new Promise(r => setTimeout(r, wait))
    const state = expr ? await evaluate(p, expr).catch((e: unknown) => String(e)) : undefined
    const errs = lines.filter(l => /exception|console.error|log.error|Content Security Policy|Refused|request failed|HTTP [45]/.test(l))
    bad += errs.length
    console.log(`== ${url}\n   CSP: ${csp}\n${lines.map(l => "   " + l).join("\n") || "   (console clean)"}${state === undefined ? "" : "\n   eval: " + JSON.stringify(state)}`)
    await p.send("Target.closeTarget" as never, { targetId: p.targetId } as never).catch(() => {})
  }
} finally { await b.close() }
process.exit(bad ? 1 : 0)
