import { spawn } from "node:child_process";

const maxShutdownMs = 5000;
const maxOutputDrainMs = 5000;
const maxOutputBytes = 1_048_576;
const maxTimeoutMs = 2_147_483_647;

export async function runWrangler(program, args, { stdio, signal, onChild, timeoutMs }) {
  signal?.throwIfAborted();
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimeoutMs))
    throw new RangeError(`Wrangler timeout must be an integer from 1 to ${maxTimeoutMs} milliseconds.`);
  const child = spawn(program, args, { stdio });
  const output = [];
  let bytes = 0,
    failure,
    failed = false,
    exited = false,
    settled = false,
    finishDrain,
    drainTimer,
    killTimer;
  function stopChild() {
    if (exited || killTimer) return;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), maxShutdownMs);
    killTimer.unref();
  }
  function abortChild() {
    if (settled) return;
    failure ??= "aborted";
    if (exited) finishDrain?.();
    else stopChild();
  }
  child.stdout?.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > maxOutputBytes) {
      failure ??= "output-limit";
      stopChild();
    } else output.push(chunk);
  });
  const { promise: finished, resolve: resolveExit } = Promise.withResolvers();
  const finish = (status) => {
    settled = true;
    finishDrain = undefined;
    resolveExit({
      status: failed || failure ? 1 : status,
      stdout: Buffer.concat(output).toString("utf8"),
      failure,
    });
  };
  child.on("error", () => {
    failed = true;
  });
  child.once("close", finish);
  signal?.addEventListener("abort", abortChild, { once: true });
  const timeout =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          failure ??= "timeout";
          stopChild();
        }, timeoutMs);
  timeout?.unref();
  child.once("exit", (status) => {
    exited = true;
    clearTimeout(timeout);
    clearTimeout(killTimer);
    if (!child.stdout && !child.stderr) return;
    finishDrain = () => {
      child.removeListener("close", finish);
      child.stdout?.destroy();
      child.stderr?.destroy();
      finish(status);
    };
    if (signal?.aborted) abortChild();
    else {
      drainTimer = setTimeout(() => {
        failure ??= "output-drain";
        finishDrain?.();
      }, maxOutputDrainMs);
      drainTimer.unref();
    }
  });
  try {
    if (child.pid) onChild?.(child.pid);
    return await finished;
  } catch (error) {
    stopChild();
    await finished;
    throw error;
  } finally {
    clearTimeout(timeout);
    clearTimeout(drainTimer);
    clearTimeout(killTimer);
    signal?.removeEventListener("abort", abortChild);
  }
}
