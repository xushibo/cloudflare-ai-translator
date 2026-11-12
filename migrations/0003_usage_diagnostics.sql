-- Store only a fixed failure category, never an upstream body or credentials.
ALTER TABLE ai_daily_usage ADD COLUMN last_error_reason TEXT;
