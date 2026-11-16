-- 阅读计时：按「书 + 本地日期」累计秒数，供阅读目标与年度排行使用。
CREATE TABLE IF NOT EXISTS reading_daily (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    day         TEXT NOT NULL,
    seconds     INTEGER NOT NULL DEFAULT 0 CHECK (seconds >= 0),
    updated_at  TEXT NOT NULL,
    PRIMARY KEY (document_id, day)
);

CREATE INDEX IF NOT EXISTS idx_reading_daily_day ON reading_daily(day);
