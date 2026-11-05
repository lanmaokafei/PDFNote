-- 多画布：画布可以属于某份文档，也可以不绑定（全局画布）。
-- document_id 用 SET NULL：删除文档后画布变成全局画布，卡片与坐标都不丢。
CREATE TABLE IF NOT EXISTS mindmap_canvases (
    id              TEXT PRIMARY KEY,
    document_id     TEXT REFERENCES documents(id) ON DELETE SET NULL,
    name            TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mindmap_canvases_document
    ON mindmap_canvases(document_id);

-- 兼容 0.19.0 及更早的单画布数据：main 是全局默认画布。
INSERT OR IGNORE INTO mindmap_canvases (id, document_id, name, created_at, updated_at)
VALUES ('main', NULL, '默认画布', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

-- 早期备份里可能出现过其他 canvas_id，这里一并登记，避免画布消失但布局还在。
INSERT OR IGNORE INTO mindmap_canvases (id, document_id, name, created_at, updated_at)
SELECT DISTINCT canvas_id, NULL, canvas_id,
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM mindmap_layout
WHERE canvas_id <> 'main';

-- 0.19.0 及更早的脑图卡片必定属于 main；若备份里缺布局行，补一行让它们仍显示在默认画布。
-- 坐标由前端的树形布局重新生成，这里只保证归属关系不丢。
INSERT OR IGNORE INTO mindmap_layout (card_id, canvas_id, x, y, updated_at)
SELECT c.id, 'main', 80, 80, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM cards c
WHERE c.surface_mindmap = 1
  AND NOT EXISTS (SELECT 1 FROM mindmap_layout l WHERE l.card_id = c.id);
