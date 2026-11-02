# Apple Vision OCR

版本：0.8.0

## 目标

扫描版 PDF 没有文字层，框选后 `getTextContent()` 返回空字符串。OCR 纳入建卡主路径：

1. 用户在 PDF 上框选高亮/矩形区域。
2. 若该区域有文字层，直接使用 PDF 原文。
3. 若无文字层，从已渲染 Canvas 裁剪选区（OCR 大图 ≤2400px，存档图 ≤1000px）。
4. 调用 `ocr_image` Tauri 命令，由 Rust 侧 Apple Vision 识别。
5. 识别文本写入 `Card.excerpt`，与标注在同一事务中建卡。
6. OCR 失败、结果为空或疑似公式时，仍创建卡片并保留选区原图（`cards.excerpt_image`）。

## 单引擎策略

PDFNote 仅在 macOS 运行，OCR 只有一个引擎：**Apple Vision**。

- Rust 命令 `ocr_image`：data URL → base64 解码 → `RgbImage` → `rightkit_ocr::vision::recognize`。
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

- Rust 集成测试 `native_vision_recognizes_chinese_data_url`（默认 ignore，需 `OCR_TEST_IMAGE`）：在真机生成中文图「信息系统项目管理包括信息化和五个过程组」，Vision 成功识别出「信息化」。
- 浏览器 `npm run dev` 仅预览 UI，不提供 OCR；OCR 必须在 Tauri 桌面应用内运行。
- 建卡事务测试：仅有标注、无 excerpt/note/question 的扫描页卡片可成功创建。

## 限制

- 仅识别用户框选区域，不生成整页可搜索 PDF。
- 图表、竖排文字、手写体与数学公式的识别质量有限；公式走图像摘录路径。
- 选区过小、页面未渲染完成或图像模糊时可能识别为空，此时创建图像摘录卡片。
- 首次调用 Vision 需要加载系统模型，真机测试首次约 28 秒，后续调用明显更快；界面显示「正在使用 Apple Vision 识别选中区域…」。
- OCR 文本与摘录图随数据库备份，不会上传到任何服务。
