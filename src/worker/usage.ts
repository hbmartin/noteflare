import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "./env";
import { emptyUsage, USAGE_COUNTERS, USAGE_SCHEMA, type UsageCounters } from "../shared/platform-costs";

export type UsageIdentity = { workspaceId?: string | undefined; pageId?: string | undefined };
type UsageContext = UsageIdentity & {
  crossWorkspace?: boolean;
  shared: boolean;
  operation: string;
  usage: UsageCounters;
};
const storage = new AsyncLocalStorage<UsageContext>();
export function setUsageIdentity(workspaceId: string, pageId?: string) {
  const context = storage.getStore();
  if (!context || context.crossWorkspace) return;
  if (context.workspaceId && context.workspaceId !== workspaceId) {
    context.shared = true;
    context.crossWorkspace = true;
    context.workspaceId = undefined;
    context.pageId = undefined;
    return;
  }
  context.workspaceId = workspaceId;
  if (pageId) {
    if (context.pageId && context.pageId !== pageId) context.shared = true;
    context.pageId = context.shared ? undefined : pageId;
  }
}
export function addUsage(values: Partial<UsageCounters>) {
  const context = storage.getStore();
  if (!context) return;
  for (const key of USAGE_COUNTERS) {
    const value = values[key];
    if (value !== undefined && Number.isFinite(value) && value >= 0) context.usage[key] += value;
  }
}
function d1Result(value: unknown) {
  if (!value || typeof value !== "object" || !("meta" in value)) return;
  const meta = value.meta as D1Meta;
  if (Number.isFinite(meta.rows_read) && Number.isFinite(meta.rows_written))
    addUsage({ d1RowsRead: meta.rows_read, d1RowsWritten: meta.rows_written, d1MeasuredQueries: 1 });
}
function wrapDatabase<T extends Pick<D1Database, "prepare" | "batch">>(database: T): T {
  const statements = new WeakMap<object, D1PreparedStatement>();
  function statement(raw: D1PreparedStatement): D1PreparedStatement {
    const proxy = new Proxy(raw, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => statement(target.bind(...values));
        const method = Reflect.get(target, property, target);
        if (["all", "run", "first", "raw"].includes(String(property)))
          return async (...args: unknown[]) => {
            addUsage({ d1Queries: 1 });
            const result = await Reflect.apply(method, target, args);
            d1Result(result);
            return result;
          };
        return typeof method === "function" ? method.bind(target) : method;
      },
    });
    statements.set(proxy, raw);
    return proxy;
  }
  return new Proxy(database, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => statement(target.prepare(sql));
      if (property === "batch")
        return async (items: D1PreparedStatement[]) => {
          addUsage({ d1Queries: items.length });
          const results = await target.batch(items.map((item) => statements.get(item) ?? item));
          results.forEach(d1Result);
          return results;
        };
      const method = Reflect.get(target, property, target);
      if (property === "withSession" && typeof method === "function")
        return (...args: unknown[]) => wrapDatabase(Reflect.apply(method, target, args) as D1DatabaseSession);
      return typeof method === "function" ? method.bind(target) : method;
    },
  });
}
function wrapBucket(bucket: R2Bucket): R2Bucket {
  return new Proxy(bucket, {
    get(target, property) {
      const method = Reflect.get(target, property, target);
      if (["get", "head", "put", "list"].includes(String(property)))
        return async (...args: unknown[]) => {
          addUsage(property === "get" || property === "head" ? { r2ClassB: 1 } : { r2ClassA: 1 });
          return Reflect.apply(method, target, args);
        };
      return typeof method === "function" ? method.bind(target) : method;
    },
  });
}
/** Proxies carry no request state: counters live exclusively in AsyncLocalStorage. */
const wrapped = new WeakSet<Env>();
export function usageBindings(env: Env): Env {
  if (env.COST_REPORTING_ENABLED !== "true" || wrapped.has(env)) return env;
  const result = {
    ...env,
    DB: wrapDatabase(env.DB),
    BUCKET: wrapBucket(env.BUCKET),
    ...(env.PUBLICATIONS_BUCKET ? { PUBLICATIONS_BUCKET: wrapBucket(env.PUBLICATIONS_BUCKET) } : {}),
    ...(env.AUDIT_BUCKET ? { AUDIT_BUCKET: wrapBucket(env.AUDIT_BUCKET) } : {}),
  };
  wrapped.add(result);
  return result;
}
export async function withUsage<T>(
  env: Env,
  operation: string,
  callback: (bindings: Env) => Promise<T>,
  identity: UsageIdentity = {},
): Promise<T> {
  if (env.COST_REPORTING_ENABLED !== "true" || storage.getStore()) return callback(env);
  const context: UsageContext = { ...identity, shared: false, operation, usage: emptyUsage() };
  const startedAt = performance.now();
  return storage.run(context, async () => {
    try {
      return await callback(usageBindings(env));
    } finally {
      context.usage.durationMs = Math.max(0, performance.now() - startedAt);
      context.usage.operations = 1;
      try {
        env.OBSERVABILITY?.writeDataPoint({
          indexes: [`usage:${context.workspaceId ?? "installation"}`],
          blobs: [USAGE_SCHEMA, context.workspaceId ?? "", context.shared ? "" : (context.pageId ?? ""), operation],
          doubles: USAGE_COUNTERS.map((key) => context.usage[key]),
        });
      } catch {
        /* Telemetry must never fail an application operation. */
      }
    }
  });
}
