// Local-only caller for ephem's Admin RPC (see wrangler.jsonc next to this file).
interface Admin {
  ingest(o?: { force?: boolean }): Promise<unknown>
  status(): Promise<unknown>
}
export default {
  async fetch(req: Request, env: { ADMIN: Admin }): Promise<Response> {
    const u = new URL(req.url)
    if (u.pathname === "/status") return Response.json(await env.ADMIN.status())
    if (u.pathname === "/ingest") return Response.json(await env.ADMIN.ingest({ force: u.searchParams.has("force") }))
    return new Response("GET /status | /ingest[?force=1]\n", { status: 404 })
  },
}
