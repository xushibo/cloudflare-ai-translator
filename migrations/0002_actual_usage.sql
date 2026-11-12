-- Keep daily_budget as historical reservation data; it no longer gates inference.
CREATE TABLE IF NOT EXISTS ai_daily_usage (
  account_id TEXT NOT NULL,
  day TEXT NOT NULL,
  neurons REAL CHECK (neurons >= 0),
  checked_at INTEGER NOT NULL DEFAULT 0,
  next_refresh_at INTEGER NOT NULL DEFAULT 0,
  lease_id TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  last_error INTEGER NOT NULL DEFAULT 0 CHECK (last_error IN (0, 1)),
  PRIMARY KEY (account_id, day)
);
