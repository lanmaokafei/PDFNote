-- 回收站：删除卡片只登记一行，卡片本体与复习记录保留，可恢复。
CREATE TABLE IF NOT EXISTS card_trash (
    card_id    TEXT PRIMARY KEY REFERENCES cards(id) ON DELETE CASCADE,
    deleted_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_card_trash_deleted_at ON card_trash(deleted_at);
