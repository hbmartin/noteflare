/** SQLite evaluates 'now' at statement execution, including time queued before a guarded write. */
export const SQL_NOW_MS = "CAST(ROUND((julianday('now')-2440587.5)*86400000) AS INTEGER)";
export const SQL_NOW_ISO = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
