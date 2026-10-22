import type { UnauthorizedResolution } from "./api";
import { realtimeAccessAccount, type RealtimeAccessAccount } from "./realtime-access-status";

const preservation = new Set<{ account: RealtimeAccessAccount | null; preserve: () => void }>();
let current: { account: RealtimeAccessAccount | null; result: Promise<UnauthorizedResolution> } | undefined;

/** Publish the winning attempt before invoking App, including synchronous failures. */
export function trackAuthorization(account: RealtimeAccessAccount | null, run: () => Promise<UnauthorizedResolution>) {
  const result = Promise.resolve().then(run);
  current = { account, result };
  return result;
}
export function currentAuthorization(account: RealtimeAccessAccount | null) {
  return account === realtimeAccessAccount() && current?.account === account ? current.result : undefined;
}
export function registerAuthorizationPreservation(preserve: () => void) {
  const registration = { account: realtimeAccessAccount(), preserve };
  preservation.add(registration);
  return () => {
    preservation.delete(registration);
  };
}
/** Must run synchronously before App unmounts the workspace. Storage failure is isolated per editor. */
export function preserveBeforeAuthorizationExit(account: RealtimeAccessAccount | null) {
  if (account !== realtimeAccessAccount()) return;
  for (const entry of preservation)
    if (entry.account === account) {
      try {
        entry.preserve();
      } catch (error) {
        console.error("Unable to preserve authorization recovery", error);
      }
    }
}
