-- 手写本页的 OCR 索引：笔迹没有文字，只能按页渲染后识别。
-- 派生数据；signature 记录当页笔迹指纹（笔数 + 最后更新时间），变了才重新识别。
CREATE TABLE IF NOT EXISTS notebook_page_index (
  notebook_id TEXT NOT NULL,
  page INTEGER NOT NULL,
  text TEXT NOT NULL,
  signature TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (notebook_id, page)
);
