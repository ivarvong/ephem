// Minimal ambient declarations for the Durable Object runtime this package uses (packages/worker/src/cloudflare.d.ts does the
// same for WorkerEntrypoint): @cloudflare/workers-types conflicts with the DOM lib the shared tsconfig uses.
declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState
    protected readonly env: Env
    constructor(ctx: DurableObjectState, env: Env)
  }
}
interface SqlCursor<T> {
  toArray(): T[]
}
interface DurableObjectState {
  readonly storage: {
    readonly sql: { exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlCursor<T> }
    setAlarm(at: number): Promise<void>
  }
}
/** An RPC stub: every method returns a promise. */
type Stub<T> = { [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never }
interface DurableObjectNamespace<T> {
  idFromName(name: string): unknown
  get(id: unknown, options?: { locationHint?: string }): Stub<T>
}
