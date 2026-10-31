// Local server over the same handler (src/dev-handler.ts). Origin = range reads of a local copy of the DE440 file (data/jpl/),
// so the cross-check harness exercises the exact R2 byte-range path without Cloudflare.
//   node --experimental-strip-types packages/worker/src/dev.ts [port]              # pages from the web build (npm run build)
//   EPHEM_VITE=1 node --experimental-strip-types packages/worker/src/dev.ts [port] # `npm run dev`: Vite dev modules, HMR
// The Worker's modules load through Vite (ssrLoadModule: it compiles the page components' TSX; packages/web/vite.config.ts).
// Static assets (packages/web/dist/client) are served as Workers Static Assets serves them: a file under /assets/ answers
// before the Worker, immutable (its _headers). With EPHEM_VITE=1, Vite's middleware serves the client modules and the HMR socket.
import { createServer } from "node:http"
import { constants as zlib, createGzip } from "node:zlib"
import { readFile } from "node:fs/promises"
import { extname, resolve } from "node:path"
import { createServer as createVite } from "vite"

const port = Number(process.argv[2] ?? 8787),
  hot = process.env["EPHEM_VITE"] === "1"
const ASSETS = resolve(import.meta.dirname, "../../web/dist/client")
const TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".json": "application/json",
}
const staticAsset = async (path: string): Promise<Response | undefined> => {
  if (!/^\/assets\/[A-Za-z0-9_.-]+$/.test(path) && path !== "/ephem-assets.json") return undefined
  const b = await readFile(resolve(ASSETS, path.slice(1))).catch(() => undefined)
  return (
    b &&
    new Response(b, {
      headers: {
        "content-type": TYPES[extname(path)] ?? "application/octet-stream",
        "cache-control": "public, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "access-control-allow-origin": "*",
      },
    })
  )
}

const http = createServer()
const vite = await createVite({
  configFile: resolve(import.meta.dirname, "../../web/vite.config.ts"),
  appType: "custom",
  logLevel: "warn",
  server: { middlewareMode: true, hmr: hot ? { server: http } : false },
})
const { devHandler, FILE } = (await vite.ssrLoadModule(
  resolve(import.meta.dirname, "dev-handler.ts"),
)) as typeof import("./dev-handler.ts")
const handler = await devHandler(hot)

http.on("request", async (req, res) => {
  const path = (req.url ?? "/").split("?")[0]!
  if (hot && /^\/(@vite|@id|@fs|@react-refresh|@prefresh|src\/|node_modules\/)/.test(path)) {
    vite.middlewares(req, res)
    return
  }
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer) // POST bodies (/mcp, /v1/alignment/search)
  const method = req.method ?? "GET",
    body = method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks)
  const r =
    (await staticAsset(path)) ??
    (await handler(
      new Request(`http://127.0.0.1:${port}${req.url ?? "/"}`, {
        method,
        headers: req.headers as Record<string, string>,
        ...(body ? { body } : {}),
      }),
    ))
  // As Cloudflare does: the body streams chunk by chunk (the homepage flushes its head first), gzip-compressed for text when the
  // browser accepts it, each chunk flushed at once (Z_SYNC_FLUSH), so local journeys see production's bytes and chunking.
  const h = Object.fromEntries(r.headers),
    gz =
      /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? "")) &&
      /^(text\/|application\/(json|javascript))/.test(h["content-type"] ?? "")
  if (gz) {
    h["content-encoding"] = "gzip"
    delete h["content-length"]
  }
  res.writeHead(r.status, h)
  if (!r.body || method === "HEAD") {
    res.end()
    return
  }
  const out = gz ? createGzip({ flush: zlib.Z_SYNC_FLUSH }) : undefined
  if (out) out.pipe(res)
  for await (const c of r.body) (out ?? res).write(c)
  ;(out ?? res).end()
})
http.listen(port, "127.0.0.1", () =>
  console.log(
    `ephem dev server on http://127.0.0.1:${port} (DE440 from ${FILE}; ${hot ? "Vite dev modules, HMR" : "the web build"})`,
  ),
)
