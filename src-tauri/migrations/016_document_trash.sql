-- 文档回收站：删除整本书先登记，PDF 副本与卡片都保留，可恢复。
-- 与 card_trash 不同，这里不逐张登记卡片：卡片通过所属文档被过滤掉。
CREATE TABLE IF NOT EXISTS document_trash (
    document_id TEXT PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
    deleted_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_document_trash_deleted_at ON document_trash(deleted_at);
