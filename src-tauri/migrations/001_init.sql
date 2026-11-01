CREATE TABLE documents (
    id              TEXT PRIMARY KEY,
    title           TEXT NOT NULL,
    stored_path     TEXT NOT NULL,
    original_path   TEXT,
    content_hash    TEXT NOT NULL UNIQUE,
    file_size       INTEGER NOT NULL DEFAULT 0 CHECK (file_size >= 0),
    page_count      INTEGER NOT NULL DEFAULT 0 CHECK (page_count >= 0),
    file_status     TEXT NOT NULL DEFAULT 'ready'
                    CHECK (file_status IN ('importing', 'ready', 'missing', 'mismatch')),
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE cards (
    id                  TEXT PRIMARY KEY,
    document_id         TEXT REFERENCES documents(id) ON DELETE SET NULL,
    page                INTEGER CHECK (page IS NULL OR page > 0),
    bbox_x              REAL,
    bbox_y              REAL,
    bbox_width          REAL,
    bbox_height         REAL,
    excerpt             TEXT NOT NULL DEFAULT '',
    user_note           TEXT NOT NULL DEFAULT '',
    question            TEXT NOT NULL DEFAULT '',
    parent_id           TEXT REFERENCES cards(id) ON DELETE SET NULL,
    sort_order          INTEGER NOT NULL DEFAULT 0,
    collapsed           INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
    stability           REAL NOT NULL DEFAULT 0 CHECK (stability >= 0),
    difficulty          REAL NOT NULL DEFAULT 0 CHECK (difficulty >= 0),
    elapsed_days        REAL NOT NULL DEFAULT 0,
    scheduled_days      INTEGER NOT NULL DEFAULT 0 CHECK (scheduled_days >= 0),
    learning_steps      INTEGER NOT NULL DEFAULT 0,
    due                 TEXT NOT NULL,
    last_review         TEXT,
    reps                INTEGER NOT NULL DEFAULT 0 CHECK (reps >= 0),
    lapses              INTEGER NOT NULL DEFAULT 0 CHECK (lapses >= 0),
    review_state        TEXT NOT NULL DEFAULT 'new'
                        CHECK (review_state IN ('new', 'learning', 'review', 'relearning')),
    surface_pdf         INTEGER NOT NULL DEFAULT 1 CHECK (surface_pdf IN (0, 1)),
    surface_mindmap     INTEGER NOT NULL DEFAULT 1 CHECK (surface_mindmap IN (0, 1)),
    surface_review      INTEGER NOT NULL DEFAULT 1 CHECK (surface_review IN (0, 1)),
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL,
    CHECK (
        (document_id IS NULL AND page IS NULL AND bbox_x IS NULL AND bbox_y IS NULL
            AND bbox_width IS NULL AND bbox_height IS NULL)
        OR
        (document_id IS NOT NULL AND page IS NOT NULL AND bbox_x IS NOT NULL
            AND bbox_y IS NOT NULL AND bbox_width IS NOT NULL AND bbox_height IS NOT NULL)
    ),
    CHECK (bbox_x IS NULL OR (bbox_x >= 0 AND bbox_x <= 1)),
    CHECK (bbox_y IS NULL OR (bbox_y >= 0 AND bbox_y <= 1)),
    CHECK (bbox_width IS NULL OR (bbox_width > 0 AND bbox_x + bbox_width <= 1.000001)),
    CHECK (bbox_height IS NULL OR (bbox_height > 0 AND bbox_y + bbox_height <= 1.000001)),
    CHECK (parent_id IS NULL OR parent_id <> id)
);

CREATE TABLE annotations (
    id              TEXT PRIMARY KEY,
    card_id         TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL CHECK (kind IN ('highlight', 'underline', 'text', 'rectangle')),
    page            INTEGER NOT NULL CHECK (page > 0),
    geometry_json   TEXT NOT NULL CHECK (json_valid(geometry_json)),
    style_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(style_json)),
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE mindmap_layout (
    card_id         TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    canvas_id       TEXT NOT NULL DEFAULT 'main',
    x               REAL NOT NULL DEFAULT 0,
    y               REAL NOT NULL DEFAULT 0,
    updated_at      TEXT NOT NULL,
    PRIMARY KEY (canvas_id, card_id)
);

CREATE TABLE review_logs (
    id                  TEXT PRIMARY KEY,
    card_id             TEXT NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    client_event_id     TEXT NOT NULL UNIQUE,
    session_id          TEXT,
    rating              INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 4),
    source              TEXT NOT NULL DEFAULT 'flashcard'
                        CHECK (source IN ('flashcard', 'document_recall', 'mindmap_recall')),
    previous_state      TEXT NOT NULL,
    previous_due        TEXT NOT NULL,
    new_due             TEXT NOT NULL,
    new_state           TEXT NOT NULL DEFAULT 'new'
                        CHECK (new_state IN ('new', 'learning', 'review', 'relearning')),
    stability           REAL NOT NULL,
    difficulty          REAL NOT NULL,
    elapsed_days        REAL NOT NULL DEFAULT 0,
    scheduled_days      INTEGER NOT NULL DEFAULT 0 CHECK (scheduled_days >= 0),
    learning_steps      INTEGER NOT NULL DEFAULT 0 CHECK (learning_steps >= 0),
    reps                INTEGER NOT NULL DEFAULT 0 CHECK (reps >= 0),
    lapses              INTEGER NOT NULL DEFAULT 0 CHECK (lapses >= 0),
    payload_json        TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
    scheduler_version   TEXT NOT NULL,
    reviewed_at         TEXT NOT NULL
);

CREATE INDEX idx_cards_review_due
    ON cards(due, review_state)
    WHERE surface_review = 1;

CREATE INDEX idx_cards_document_page
    ON cards(document_id, page)
    WHERE surface_pdf = 1;

CREATE INDEX idx_cards_mindmap_children
    ON cards(parent_id, sort_order)
    WHERE surface_mindmap = 1;

CREATE INDEX idx_annotations_card ON annotations(card_id);
CREATE INDEX idx_annotations_page ON annotations(page);
CREATE INDEX idx_mindmap_layout_canvas ON mindmap_layout(canvas_id);
CREATE INDEX idx_review_logs_card_time ON review_logs(card_id, reviewed_at DESC);
CREATE INDEX idx_review_logs_reviewed_at ON review_logs(reviewed_at);

