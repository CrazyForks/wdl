CREATE TABLE IF NOT EXISTS s3_cleanup_task (
  id TEXT PRIMARY KEY,
  source_json TEXT NOT NULL,
  prefixes_json TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  next_attempt_at INTEGER,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_s3_cleanup_pending_due
  ON s3_cleanup_task (next_attempt_at)
  WHERE state = 'pending';
