-- 0.38.0 画布涂鸦与脑图分层：复用 v10 的 layers 表，只补两张关联表，不改现有表结构。
-- canvas_inks 的点用 React Flow 世界坐标（跟随平移缩放），不做归一化。

CREATE TABLE IF NOT EXISTS canvas_inks (
    id              TEXT PRIMARY KEY,
    canvas_id       TEXT NOT NULL REFERENCES mindmap_canvases(id) ON DELETE CASCADE,
    layer_id        TEXT NOT NULL REFERENCES layers(id) ON DELETE CASCADE,
    points_json     TEXT NOT NULL CHECK (json_valid(points_json)),
    style_json      TEXT NOT NULL CHECK (json_valid(style_json)),
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_canvas_inks_canvas
    ON canvas_inks(canvas_id);

CREATE INDEX IF NOT EXISTS idx_canvas_inks_layer
    ON canvas_inks(layer_id);

-- 卡片归属哪个画布图层：没有行的卡片属于「未分层」，永远可见。
CREATE TABLE IF NOT EXISTS mindmap_layer_members (
    layer_id        TEXT NOT NULL REFERENCES layers(id) ON DELETE CASCADE,
    card_id         TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    canvas_id       TEXT NOT NULL,
    PRIMARY KEY (layer_id, card_id)
);

CREATE INDEX IF NOT EXISTS idx_layer_members_canvas
    ON mindmap_layer_members(canvas_id);
