-- 复习统计的物化表：按「本地日期」累计次数与记得数，避免每次统计都扫 review_logs。
-- 它只是 review_logs 的聚合缓存，导入备份后会由 rebuild_review_daily 重建。
CREATE TABLE IF NOT EXISTS review_daily (
    day        TEXT PRIMARY KEY,
    reviews    INTEGER NOT NULL DEFAULT 0,
    correct    INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
);

INSERT INTO review_daily (day, reviews, correct, updated_at)
SELECT date(reviewed_at, 'localtime'),
       COUNT(*),
       COALESCE(SUM(CASE WHEN rating >= 3 THEN 1 ELSE 0 END), 0),
       MAX(reviewed_at)
FROM review_logs
WHERE reviewed_at IS NOT NULL AND reviewed_at <> ''
  AND date(reviewed_at, 'localtime') IS NOT NULL
GROUP BY date(reviewed_at, 'localtime');
