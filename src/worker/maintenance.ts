import { boundedLogString, rawSafeErrorMessage } from "../shared/error-log";
import { logger } from "./observability";
/** Lazy calls catch synchronous failures too, and every operation settles before reporting. */
export async function runMaintenance(
  label: string,
  event: string,
  operations: ReadonlyArray<readonly [string, () => Promise<unknown>]>,
) {
  const results = await Promise.allSettled(operations.map(([, run]) => Promise.resolve().then(run)));
  const failures: unknown[] = [],
    summaries: string[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status !== "rejected") continue;
    const operation = operations[index]![0];
    logger.error(event, "scheduler", `${label} maintenance operation failed`, { operation }, result.reason);
    failures.push(result.reason);
    summaries.push(`${operation}: ${boundedLogString(rawSafeErrorMessage(result.reason, "Unknown failure"), 180)}`);
  }
  if (failures.length) throw new AggregateError(failures, `${label} maintenance failed; ${summaries.join("; ")}`);
}
