-- 留白（页边草稿）：页面级独立文本，不绑定任何文字选区。
CREATE TABLE IF NOT EXISTS page_notes (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  page INTEGER NOT NULL,
  -- 归一化纵向锚点（0–1），决定便签贴在页面右侧的哪个高度。
  anchor_y REAL NOT NULL DEFAULT 0.08,
  content TEXT NOT NULL DEFAULT '',
  collapsed INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT 'amber',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_page_notes_document_page
  ON page_notes (document_id, page, anchor_y);
