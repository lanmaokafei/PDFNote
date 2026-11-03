-- 标题链接：卡片标题与别名注册为关键词，阅读时反向匹配页面文本。
ALTER TABLE cards ADD COLUMN link_aliases TEXT NOT NULL DEFAULT '';
