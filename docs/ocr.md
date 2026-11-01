# 离线中文 OCR

版本：0.2.0

## 目标

扫描版 PDF 没有文字层，框选后 `getTextContent()` 返回空字符串，旧版会因“卡片必须包含内容”而创建失败。0.2.0 将 OCR 纳入建卡主路径：

1. 用户在 PDF 上框选高亮/矩形区域。
2. 若该区域有文字层，直接使用文本。
3. 若无文字层，从已渲染 Canvas 裁剪选区，放大并压缩为 JPEG。
4. 优先调用系统原生 OCR；不可用时使用打包的 Tesseract 离线模型。
5. OCR 文本写入 Card.excerpt，再与标注在同一事务中建卡。
6. OCR 失败或结果为空时仍允许创建带来源的空白 Card，避免再次出现“创建失败”。

## 双引擎策略

| 平台 | 首选 | 兜底 |
| --- | --- | --- |
| macOS | Apple Vision（VNRecognizeTextRequest, accurate, zh-Hans + en-US） | Tesseract.js chi_sim+eng |
| Windows | Windows.Media.Ocr | Tesseract.js chi_sim+eng |
| Linux | — | Tesseract.js chi_sim+eng |

- 原生 OCR 由 Rust 命令 `ocr_image` 执行，调用 `rightkit-ocr` 的原生后端；图像通过 base64 data URL 传入，仅在应用进程内处理。
- Tesseract.js 的 worker、WASM core、`chi_sim` / `eng` 模型全部位于 `public/ocr/`，随安装包分发。
- 初始化参数：LSTM only、自动页面分割、保留词间空格、300 DPI 提示。
- 中文结果会清理汉字之间的多余空格。

## 离线资源

```text
public/ocr/
  worker.min.js
  NOTICE.txt
  core/
    tesseract-core-lstm.wasm(.js)
    tesseract-core-simd-lstm.wasm(.js)
    tesseract-core-relaxedsimd-lstm.wasm(.js)
  lang/
    chi_sim.traineddata.gz
    eng.traineddata.gz
```

首次使用 Tesseract 时需要加载约 30MB 压缩语言模型，界面会显示“正在识别选中区域的中文文字…”。macOS 使用 Vision 时不加载这些模型，因此首次响应更快。

## 质量与限制

- 在《信息系统项目管理师教程-第四版》第 20 页（952×1347 扫描图）上，Vision 识别结果可读，Tesseract 存在较多错字；因此 macOS 默认优先 Vision。
- OCR 只识别用户框选区域，不生成整页可搜索 PDF。
- 公式、图表、竖排文字和手写体的识别质量有限。
- OCR 文本进入 Card.excerpt，会随数据库一起备份；不会上传到任何服务。
- 若选区太小、页面尚未完成渲染或图像模糊，可能识别为空，此时仍会创建空白摘录卡片。

## 验证

- Rust 原生 Vision 数据链路测试：同一页中文识别约 1.1 秒，结果包含“信息化”。
- 浏览器 Tesseract 离线测试：无网络请求，识别出“信息系统项目管理师教程 / 第四版 / 项目范围管理”等文本。
- 建卡事务测试：仅有标注、无 excerpt/note/question 的扫描页卡片可成功创建。
