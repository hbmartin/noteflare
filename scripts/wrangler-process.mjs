import { spawn } from "node:child_process";

const maxShutdownMs = 5000;
const maxOutputBytes = 1_048_576;

export async function runWrangler(program, args, { stdio, signal, onChild, timeoutMs }) {
  signal?.throwIfAborted();
  const child = spawn(program, args, { stdio });
  const output = [];
  let bytes = 0,
    failure,
    failed = false,
    killTimer;
  function stopChild() {
    if (killTimer) return;
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), maxShutdownMs);
    killTimer.unref();
  }
  child.stdout?.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > maxOutputBytes) {
      failure ??= "output-limit";
      stopChild();
    } else output.push(chunk);
  });
  const finished = new Promise((resolveExit) => {
    child.on("error", () => {
      failed = true;
    });
    child.once("close", (status) =>
      resolveExit({
        status: failed || failure ? 1 : status,
        stdout: Buffer.concat(output).toString("utf8"),
        failure,
      }),
    );
  });
  signal?.addEventListener("abort", stopChild, { once: true });
  const timeout =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          failure ??= "timeout";
          stopChild();
        }, timeoutMs);
  timeout?.unref();
  try {
    if (child.pid) onChild?.(child.pid);
    return await finished;
  } catch (error) {
    stopChild();
    await finished;
    throw error;
  } finally {
    clearTimeout(timeout);
    clearTimeout(killTimer);
    signal?.removeEventListener("abort", stopChild);
  }
}
