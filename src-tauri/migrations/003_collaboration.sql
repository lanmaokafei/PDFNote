-- 0.6.0：卡片标签、卡片间链接、页面手写墨迹。
CREATE TABLE card_tags (
    card_id         TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    tag             TEXT NOT NULL,
    created_at      TEXT NOT NULL,
    PRIMARY KEY (card_id, tag)
);

CREATE INDEX idx_card_tags_tag ON card_tags(tag);

CREATE TABLE card_links (
    id                  TEXT PRIMARY KEY,
    source_card_id      TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    target_card_id      TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    label               TEXT NOT NULL DEFAULT '',
    created_at          TEXT NOT NULL,
    UNIQUE (source_card_id, target_card_id),
    CHECK (source_card_id <> target_card_id)
);

CREATE INDEX idx_card_links_source ON card_links(source_card_id);
CREATE INDEX idx_card_links_target ON card_links(target_card_id);

CREATE TABLE page_inks (
    id              TEXT PRIMARY KEY,
    document_id     TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page            INTEGER NOT NULL CHECK (page > 0),
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

CREATE INDEX idx_page_inks_document_page ON page_inks(document_id, page);
