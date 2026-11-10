CREATE TABLE IF NOT EXISTS document_readings (
  document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  pass INTEGER NOT NULL DEFAULT 1,
  recall_note TEXT NOT NULL DEFAULT '',
  toc_json TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
