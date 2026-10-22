export type RealtimeAccessStatus = { revision: number; completedRevision: number; complete: boolean };
export function validRealtimeAccessStatus(value: RealtimeAccessStatus) {
  return (
    !!value &&
    Number.isSafeInteger(value.revision) &&
    value.revision >= 0 &&
    Number.isSafeInteger(value.completedRevision) &&
    value.completedRevision >= 0 &&
    value.completedRevision <= value.revision &&
    value.complete === value.completedRevision >= value.revision
  );
}
