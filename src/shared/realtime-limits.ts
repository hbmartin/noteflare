/** A socket never outlives its signed grant. Skew applies only to room registration validation. */
export const REALTIME_GRANT_MS = 5 * 60_000;
export const REALTIME_ROOM_MARGIN_MS = 5_000;
export const REALTIME_CLOCK_SKEW_MS = 1_000;
export const TABLE_RENEWAL_LEAD_MS = 30_000;
