-- 标记页索引来源：text = PDF 文本层，ocr = 扫描页经 Apple Vision 识别。
-- 用于「全库建索引」判断哪些页还需要 OCR，以及统计进度。
ALTER TABLE page_index ADD COLUMN source TEXT NOT NULL DEFAULT 'text';
