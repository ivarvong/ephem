// /docs without JavaScript, /llms.txt, /docs/interactive (round-2 #7).
import { describe, expect, it } from "vitest"
import { QUERY_PARAMS } from "@ephem/api"
import { makeHandler } from "../src/app.ts"
import { direct, makeBlocks } from "../src/blocks.ts"
import { ENDPOINTS } from "../src/docs.ts"

const handler = makeHandler(makeBlocks(direct(async () => { throw new Error("no blocks needed") })))
const get = async (p: string) => { const r = await handler(new Request(`http://x${p}`)); return { r, text: await r.text() } }

describe("docs for non-browser clients", () => {
  it("/docs is plain HTML: no script, links the spec, llms.txt, MCP and every endpoint with every parameter", async () => {
    const { r, text } = await get("/docs")
    expect(r.status).toBe(200); expect(r.headers.get("content-type")).toMatch(/text\/html/)
    expect(text).not.toMatch(/<script/)
    for (const s of ['href="/openapi.json"', 'href="/llms.txt"', "/mcp", 'href="/docs/interactive"']) expect(text).toContain(s)
    for (const [path, ps] of Object.entries(QUERY_PARAMS)) { expect(text).toContain(`<code>${path}</code>`); for (const p of ps) expect(text).toMatch(new RegExp(`[ >]${p}\\*?[,<]`)) }
  })
  it("every documented required parameter exists, and every contract route is documented", () => {
    expect(ENDPOINTS.map(e => e.path).toSorted()).toEqual(Object.keys(QUERY_PARAMS).toSorted())
    for (const e of ENDPOINTS) for (const p of e.required) expect(QUERY_PARAMS[e.path]).toContain(p)
  })
  it("/llms.txt: text, the spec, MCP endpoint, endpoints with params and examples, conventions", async () => {
    const { r, text } = await get("/llms.txt")
    expect(r.status).toBe(200); expect(r.headers.get("content-type")).toMatch(/text\/plain/)
    expect(text).toMatch(/^# ephem\n/)
    for (const s of ["/openapi.json", "/mcp", "## Endpoints", "## Conventions", "targetHeightRef", "litCentroid", "terrestrial"]) expect(text).toContain(s)
    for (const path of Object.keys(QUERY_PARAMS)) expect(text).toContain(`- ${path}: `)
  })
  it("/docs/interactive is the Scalar page", async () => {
    const { text } = await get("/docs/interactive")
    expect(text).toContain('data-url="/openapi.json"'); expect(text).toContain("@scalar/api-reference@")
  })
  it("examples in the docs are valid requests (no unknown parameters)", () => {
    for (const e of ENDPOINTS) { const u = new URL("http://x" + e.example); for (const k of u.searchParams.keys()) expect(QUERY_PARAMS[e.path], `${e.path} ${k}`).toContain(k) }
  })
})
