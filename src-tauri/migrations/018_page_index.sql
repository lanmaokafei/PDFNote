-- 文本层页索引：每页抽取的纯文本，供跨库搜索使用。
-- 与 page_ocr 一样是可重建的派生数据：不设外键，备份合并时允许孤儿行。
CREATE TABLE IF NOT EXISTS page_index (
  document_id TEXT NOT NULL,
  page INTEGER NOT NULL,
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (document_id, page)
);

CREATE INDEX IF NOT EXISTS idx_page_index_document ON page_index(document_id);
