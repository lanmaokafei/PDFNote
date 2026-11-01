-- 记录每份文档最后阅读页，重新打开时自动定位。
ALTER TABLE documents ADD COLUMN last_page INTEGER NOT NULL DEFAULT 1;
