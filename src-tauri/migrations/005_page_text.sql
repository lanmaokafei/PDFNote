-- 扫描页整页 OCR 的行级结果缓存。这是可重建的派生数据，不参与卡片语义，
-- 因此不设外键：备份合并时文档 id 可能变化，孤立行最多导致一次重新识别。
CREATE TABLE IF NOT EXISTS page_ocr (
  document_id TEXT NOT NULL,
  page INTEGER NOT NULL,
  lines_json TEXT NOT NULL,
  engine TEXT NOT NULL DEFAULT 'apple-vision',
  created_at TEXT NOT NULL,
  PRIMARY KEY (document_id, page)
);
