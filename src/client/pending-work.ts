let pending = 0;

/** Protect a mutation until both the request and its response have settled. */
export function retainPendingWork() {
  pending += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pending -= 1;
  };
}

export function hasPendingWork() {
  return pending > 0;
}
