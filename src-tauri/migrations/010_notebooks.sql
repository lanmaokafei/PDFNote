-- 0.36.0 图层地基与手写笔记本。
-- layers 是通用图层表：scope 预留 canvas / mindmap，本版只落 notebook，
-- 后续画布涂鸦与脑图分层复用同一张表，不再改结构。

CREATE TABLE IF NOT EXISTS notebooks (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    paper           TEXT NOT NULL DEFAULT 'lined'
                    CHECK (paper IN ('blank', 'lined', 'grid', 'dot')),
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS layers (
    id              TEXT PRIMARY KEY,
    scope           TEXT NOT NULL CHECK (scope IN ('notebook', 'canvas', 'mindmap')),
    owner_id        TEXT NOT NULL,
    name            TEXT NOT NULL,
    visible         INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1)),
    locked          INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_layers_owner
    ON layers(scope, owner_id, sort_order);

CREATE TABLE IF NOT EXISTS notebook_inks (
    id              TEXT PRIMARY KEY,
    notebook_id     TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
    page            INTEGER NOT NULL CHECK (page > 0),
    layer_id        TEXT NOT NULL REFERENCES layers(id) ON DELETE CASCADE,
    bbox_x          REAL NOT NULL,
    bbox_y          REAL NOT NULL,
    bbox_width      REAL NOT NULL,
    bbox_height     REAL NOT NULL,
    style_json      TEXT NOT NULL CHECK (json_valid(style_json)),
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    CHECK (bbox_x >= 0 AND bbox_x <= 1),
    CHECK (bbox_y >= 0 AND bbox_y <= 1),
    CHECK (bbox_width > 0 AND bbox_x + bbox_width <= 1.000001),
    CHECK (bbox_height > 0 AND bbox_y + bbox_height <= 1.000001)
);

CREATE INDEX IF NOT EXISTS idx_notebook_inks_notebook_page
    ON notebook_inks(notebook_id, page);

CREATE INDEX IF NOT EXISTS idx_notebook_inks_layer
    ON notebook_inks(layer_id);
