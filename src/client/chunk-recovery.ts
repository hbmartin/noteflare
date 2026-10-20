import { hasPendingWork } from "./pending-work";

const RELOAD_KEY = "notes:chunk-reload-at";
const COOLDOWN_MS = 60_000;
const LOAD_FAILURES = [
  "Failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "Importing a module script failed",
  "Unable to preload CSS",
];

export function isChunkLoadFailure(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return LOAD_FAILURES.some((failure) => message.includes(failure));
}

/** Only reload online, with no pending writes, and at most once per minute. */
export function claimChunkRecovery(error: unknown) {
  if (!navigator.onLine || !isChunkLoadFailure(error) || hasPendingWork()) return false;
  // Existing document/diagram guards also protect locally unsynced content and titles.
  if (!window.dispatchEvent(new Event("beforeunload", { cancelable: true }))) return false;
  try {
    const previous = Number(sessionStorage.getItem(RELOAD_KEY));
    if (previous && Date.now() - previous < COOLDOWN_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

export function installChunkRecovery() {
  window.addEventListener("beforeunload", (event) => {
    if (hasPendingWork()) event.preventDefault();
  });
}

/** Only user-visible module loads may recover the whole application. Background work handles its own failure. */
export async function loadForegroundModule<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (claimChunkRecovery(error)) window.location.reload();
    throw error;
  }
}
