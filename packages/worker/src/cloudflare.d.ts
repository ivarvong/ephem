// Minimal ambient declarations for the Workers runtime features this package uses, so it type-checks without
// @cloudflare/workers-types (which conflicts with the DOM lib the shared tsconfig uses).
declare module "cloudflare:workers" {
  export abstract class WorkerEntrypoint<Env = unknown> {
    protected readonly env: Env
    protected readonly ctx: {
      waitUntil(p: Promise<unknown>): void
      readonly exports: Record<string, { fetch(req: Request): Promise<Response> }>
    }
    constructor(ctx: unknown, env: Env)
  }
  export const tracing: import("./trace.ts").Tracing
}
declare class FixedLengthStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor(length: number)
}
declare class IdentityTransformStream extends TransformStream<Uint8Array, Uint8Array> {
  constructor()
}
interface Response {
  readonly webSocket?: unknown
}
