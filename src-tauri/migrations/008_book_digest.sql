-- AI 拆书：两阶段流程的中间产物。
-- 阶段一（先笔记）：逐块分析，把每块的摘要与条目存下来，支持中断续跑。
CREATE TABLE IF NOT EXISTS book_analysis (
  document_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  page_start INTEGER NOT NULL,
  page_end INTEGER NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  items_json TEXT NOT NULL,
  -- 该块涉及页面的归一化文本区域，用于节点链回原文。
  pages_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (document_id, mode, chunk_index),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

-- 阶段二（后整理）：汇总出的层级骨架，应用后变成卡片与脑图节点。
CREATE TABLE IF NOT EXISTS book_outline (
  document_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  outline_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (document_id, mode),
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);
