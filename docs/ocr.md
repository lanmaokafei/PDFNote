# Apple Vision OCR 与可选文字层

版本：0.9.0

## 为什么需要文字层

扫描版 PDF 只有像素，没有「文字对象」。Word 里点一下就能选中文字，是因为文字本身带位置信息；扫描页必须先 OCR 才能得到文字和坐标。

- **0.8.0 及以前**：每次框选 → 裁剪截图 → 等 Vision 识别 → 写入卡片。每框一次都要等 1–3 秒。
- **0.9.0 起**：页面打开时后台**整页识别一次**，把「每行文字 + 归一化坐标」缓存下来，在 Canvas 上铺一层透明但可选的 DOM 文字层。之后鼠标点选、拖选、复制、建卡全部是原生 DOM 操作，零延迟。

## 整页文字层（0.9.0）

### 数据来源

| 页面类型 | 行坐标来源 | 是否调用 Vision |
| --- | --- | --- |
| 有 PDF 文字层 | `page.getTextContent()` 的 `transform` / `width` / `height`，换算成归一化 top-left 坐标 | 否，瞬时 |
| 扫描页（无文字层） | `ocr_page_lines` → Apple Vision 逐行 `boundingBox` | 是，首次约 2–3 秒 |

`rightkit_ocr::vision::recognize()` 本来就返回 `OcrLine { text, rect, confidence }`，其中 `rect` 是归一化 0..1、左上原点的矩形。0.9.0 之前只取了 `text` 拼成字符串，坐标被丢掉；现在通过 `ocr_page_lines` 命令完整返回。

真机验证（1200×320 的四行中文测试图）：

```
recognized 4 lines in 2.81s
  [0.049, 0.114, 0.302, 0.103] conf=1.00 信息系统项目管理师教程
  [0.049, 0.315, 0.376, 0.104] conf=1.00 信息熵用来度量系统的不确定性
  [0.051, 0.521, 0.305, 0.104] conf=0.50 H = -SUM P(xi) log2 P(xi)
  [0.049, 0.717, 0.458, 0.121] conf=1.00 项目管理包括启动、规划、执行与收尾
```

### 缓存

- 内存 LRU（64 页）保证翻页、缩放不重复识别；同一页的并发请求共享一个 Promise。
- SQLite `page_ocr(document_id, page, lines_json, engine, created_at)`（schema v5）持久化，**重启后再次打开该页直接可用**。
- 全局最多 2 个并发 Vision 请求，快速滚动不会堆积。
- 只处理 `renderPages` 中真正渲染的页；752 页教材不会全库扫描。
- `page_ocr` 是可重建的派生数据，不设外键；备份 overwrite 导入时若备份含该表则一并恢复，merge 导入跳过（首次打开自动重建）。

### 渲染与交互

- 每行一个绝对定位的透明 `<div>`，内部 `<span>` 用 `transform: scaleX(k)` 把文字拉伸到该行的 OCR 框宽度——与 PDF.js textLayer 相同的做法，因此浏览器原生选区会按字符精确命中。
- 「文字」工具下标注 SVG 层让出鼠标事件（`pointer-events: none`），文字层接管；`::selection` 显示选中文字与蓝色高亮。
- 选中后浮出操作条：**复制**（写入系统剪贴板）/ **建卡**（选中文字 + 选区 bbox + 存档图，直接创建卡片与高亮标注）。
- 框选建卡时若文字层已就绪，也优先用 `extractTextFromLines()` 取文字，不再裁剪大图跑 OCR。

`scripts/textlayer-smoke.mjs` 用无头 Chrome 验证过：拖选得到「信息系统项目管」（精确到字符），选区 bbox 换算正确。

## 选区 OCR 建卡（原有路径）

文字层尚未就绪或用户仍使用高亮/矩形工具时，保留原有流程：

1. 在 PDF 上框选高亮/矩形区域。
2. 若该区域有文字层，直接使用 PDF 原文。
3. 若无文字层，从已渲染 Canvas 裁剪选区（OCR 大图 ≤2400px，存档图 ≤1000px）。
4. 调用 `ocr_image` Tauri 命令，由 Rust 侧 Apple Vision 识别。
5. 识别文本写入 `Card.excerpt`，与标注在同一事务中建卡。
6. OCR 失败、结果为空或疑似公式时，仍创建卡片并保留选区原图（`cards.excerpt_image`）。

## 单引擎策略

PDFNote 仅在 macOS 运行，OCR 只有一个引擎：**Apple Vision**。

- Rust 命令 `ocr_image` / `ocr_page_lines`：data URL → base64 解码 → `RgbImage` → `rightkit_ocr::vision::recognize`。
- 底层是 `VNRecognizeTextRequest`：`accurate` 级别、revision 3、开启语言校正、**自动语言检测**（中文与拉丁文同图时都正确，避免显式语言列表把 ASCII 括号转成全角）。
- `rightkit-ocr` 通过 `[target.'cfg(target_os = "macos")'.dependencies]` 只在该平台链接。
- 0.8.0 起移除 Tesseract.js、WASM core 与 `chi_sim` / `eng` 离线模型（原 `public/ocr/` 约 63MB），安装包显著缩小；CSP 也不再需要 `wasm-unsafe-eval`。

原生引擎失败时**直接抛错**，由界面提示并保留选区图像，不再静默降级到准确率更低的引擎。Vision 自带健康检查，能区分「空白页面」与「后端不可用」。

## 公式与图像摘录

Apple Vision 与所有纯文字 OCR 一样无法识别公式结构（求和、上下标、分式）。`looksLikeMathFormula()` 对结果做特征检测：

- 文字来自 OCR 且疑似公式：丢弃乱码，只存选区图像，自动打「公式」标签，提示手动补录公式内容。
- 文字来自 PDF 文字层且疑似公式：保留可信原文并附上原图。
- 扫描页无文字或 OCR 失败：创建图像摘录卡片。

摘录图随卡片备份，在脑图节点、复习闪卡与卡片编辑器中均可查看。公式内容仍需手动录入，未提供 LaTeX / Mathpix 式识别。

## 验证

- Rust 集成测试 `native_vision_recognizes_chinese_data_url`（需 `OCR_TEST_IMAGE`）：中文图识别出「信息化」。
- Rust 集成测试 `native_vision_returns_line_geometry`（需 `OCR_PAGE_TEST_IMAGE`）：返回多行且坐标全部落在 0..1。
- `node scripts/textlayer-smoke.mjs`：无头 Chrome 验证透明文字层可原生拖选。
- 浏览器 `npm run dev` 仅预览 UI，不提供 OCR；OCR 必须在 Tauri 桌面应用内运行。
- 建卡事务测试：仅有标注、无 excerpt/note/question 的扫描页卡片可成功创建。

## 限制

- 文字层是**行级**坐标：选中精度由浏览器拉伸后的字形映射决定，对常规横排文字足够；倾斜、竖排、旋转页面上对齐会偏。
- 扫描页首次打开仍需一次整页识别（约 2–3 秒，后台进行，界面显示「正在生成可选文字层…」）；之后由缓存命中。
- 图表、竖排文字、手写体与数学公式的识别质量有限；公式走图像摘录路径。
- 选区过小、页面未渲染完成或图像模糊时可能识别为空，此时创建图像摘录卡片。
- 首次调用 Vision 需要加载系统模型，后续调用明显更快。
- OCR 文本、行坐标与摘录图都保存在本地数据库并随备份恢复，不会上传到任何服务。

## 文字层几何：按 run 对齐（0.26.0）

### 症状

打开《弱传播》这类大字号排版的 PDF，进入「文字」工具后选区色块浮在文字**上方**，高度只有字高的六成；点击/拖选时字符边界也对不上。

### 根因

旧实现把每行压成一个 span：

- 字号 `line.height × 页高 × 0.86` —— 用行包围盒反推字号；
- 行顶部 `y = 1 − (基线 + item.height) / 页高` —— 把基线当成了包围盒底部；
- 整行一个 `scaleX(目标宽 / 量出的文本宽)` —— 行内混排、字距调整都会累积误差。

DOM 文本的基线在 `top + 0.8 × 字号`，而公式给的顶部比真实基线高了约 0.3 倍行高，于是文字整体上浮、选区色块只剩行盒的上半截。字号再被乘 0.86，视觉上就更小。

### 方案

1. `linesFromTextContent` 不再只吐行，而是保留每个 PDF 文本 run：`text / x / width / baselineTop / fontSize`。字号直接取 `transform` 的 `hypot(c, d)`，基线取 `transform[5]`，宽度取 `item.width`。
2. 行按**基线**聚类（容差 0.6 × 最大字号），行内不同字号（内联加粗、上标）不会被拆开；行高取最大字号。
3. `PageTextLayer` 按 run 渲染：每个 run 一个内联块，`font-size = fontSize × 页高`，`top = baselineTop × 页高 − 实测 ascent`（ascent 用 canvas 的 `fontBoundingBoxAscent` 量出来，不写死 0.8），横向 `scaleX = run 宽 / 量出的文本宽`。
4. 选区样式改成 `.pdf-text-layer.is-active ::selection`，run 的内层 span 也能画出底色。
5. 扫描页没有 run，仍按 Vision 行包围盒估算；风格保持不变。

### 稀疏文字层

有些扫描件只带一行隐藏文字或只有一个页码。现在会先算「文字覆盖面积」，稀疏**且页面存在整页图片**时才回退整页 OCR；纯矢量页（封面、扉页）即使只有一行字也保留精确的 PDF 文字层，避免 OCR 覆盖掉准确坐标。

### 验证

```bash
STEP=textlayer CARD_COUNT=3 node scripts/mindmap-regression.mjs
```

断言：字号比例精确等于 `12 / 792`（±2%）、所有行都按 run 渲染、选区文本正确、选区高度覆盖字号。

真实样本（《弱传播》第 7 页，612×792，正文 15pt、标题 21pt）：把文字层强制染色后与 PDF 字形逐行重合；选中「所有的阅读，都是等待后」时色块正好压住这 11 个字。
