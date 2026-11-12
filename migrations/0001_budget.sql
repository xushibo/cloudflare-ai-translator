CREATE TABLE IF NOT EXISTS daily_budget (
  day TEXT PRIMARY KEY,
  reserved_units INTEGER NOT NULL CHECK (reserved_units >= 0)
);
