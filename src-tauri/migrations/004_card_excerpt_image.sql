-- v4：卡片摘录图像。扫描版 PDF 框选公式/图片时，把选区截图随卡片存档，
-- 复习与脑图可直接展示原图，OCR 无法识别公式结构时也不会丢失内容。
ALTER TABLE cards ADD COLUMN excerpt_image TEXT;
