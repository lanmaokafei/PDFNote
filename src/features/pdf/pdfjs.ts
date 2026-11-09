/**
 * pdf.js 的唯一入口：必须走 legacy 构建。
 *
 * 为什么不能用常规构建：pdfjs-dist 6 的 `build/pdf.mjs` 直接调用
 * `Map.prototype.getOrInsertComputed`（2026-02 才进 Baseline，Safari 26 才有）。
 * macOS 15 及更早的 WKWebView 里这个方法不存在，打开 PDF 会直接抛
 * `this._requestsByChunk.getOrInsertComputed is not a function`
 * （分块 Range 流在 worker 里跑，所以 worker 侧同样会炸）。
 *
 * legacy 构建带 core-js 兜底与语法降级，主线程与 worker 两个 realm 都要换：
 * worker 走 `public/pdfjs/pdf.worker.legacy.min.mjs`（见 PdfWorkspace）。
 * 升级 pdfjs-dist 后必须重新拷这两个文件，否则 API / Worker 版本不一致会报错。
 */
export * from 'pdfjs-dist/legacy/build/pdf.mjs'
