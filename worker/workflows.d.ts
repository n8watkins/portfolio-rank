// The Workflows runtime API the Worker uses (worker/night.ts), and the named
// entrypoint base class (worker/index.ts), as documented
// at https://developers.cloudflare.com/workflows/build/workers-api/. The
// project generates its binding types without the runtime types
// (npm run cf-typegen, --include-runtime=false, so they don't clash with
// the DOM types Next.js needs), so this module is declared here.
declare module "cloudflare:workers" {
  export type WorkflowDuration = number | string;
  export type WorkflowStepConfig = {
    retries?: { limit: number; delay: WorkflowDuration; backoff?: "constant" | "linear" | "exponential" };
    timeout?: WorkflowDuration;
  };
  export type WorkflowEvent<T> = {
    payload: Readonly<T>;
    timestamp: Date;
    instanceId: string;
    workflowName: string;
  };
  export interface WorkflowStep {
    do<T>(name: string, callback: () => Promise<T>): Promise<T>;
    do<T>(name: string, config: WorkflowStepConfig, callback: () => Promise<T>): Promise<T>;
    sleep(name: string, duration: WorkflowDuration): Promise<void>;
  }
  export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected ctx: { waitUntil(promise: Promise<unknown>): void };
    protected env: Env;
    constructor(ctx: unknown, env: Env);
    abstract run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown>;
  }
  /** A named entrypoint (worker/index.ts CachedPages, the edge cache's target). */
  export abstract class WorkerEntrypoint<Env = unknown> {
    protected ctx: { waitUntil(promise: Promise<unknown>): void };
    protected env: Env;
    constructor(ctx: unknown, env: Env);
  }
}
