# PDFNote

本地优先、卡片轴心的 PDF 学习应用：在 PDF 上框选摘录即生成卡片，同一张卡片同时作为脑图节点和 FSRS 闪卡使用。

技术栈：Tauri v2 + React 19 + TypeScript + Vite + SQLite + PDF.js + ts-fsrs + React Flow。

## 已实现

- **本地资料库**：PDF 选择导入、SHA-256 去重、应用数据目录副本、断链检测、哈希一致性校验、重新定位、删除时保留或级联删除卡片。
- **同屏工作台**：左 PDF、右脑图，顶部悬浮分段栏，底部工具坞；分栏可拖动，脑图可一键收起。
- **PDF 工作区**：PDF.js 连续滚动与页级虚拟化、256KB Range 分块读取、缩放、页码跳转、自动回到上次阅读页、高亮/矩形框选建卡、文字层提取、Apple Vision OCR、标注拖拽、标注删除语义选择、文档遮挡主动回忆。
- **Apple Vision OCR**：macOS 原生单引擎（`VNRecognizeTextRequest` accurate / revision 3 / 自动语言检测），不打包离线模型；扫描页无文字层时自动识别选区并建卡，公式与图表保留选区原图。详见 [Apple Vision OCR](docs/ocr.md)。
- **知识脑图**：React Flow 自定义卡片节点、折叠/展开、拖拽改父级、连线改父级、防环、多选、布局持久化、独立建卡、卡片编辑、脑图逐级主动回忆。
- **FSRS 复习**：ts-fsrs 四档评分、到期队列、立即持久化、幂等事件、复习审计、每日统计、14 日趋势、正反面内容编辑。
- **备份与恢复**：ZIP 完整备份、manifest + SQLite 一致性快照 + PDF 副本、哈希与 schema 校验、merge/overwrite 导入、自动备份保留 5 份、防 zip slip。
- **本地优先**：无账号、无云同步、业务功能不发起网络请求；最小 Tauri 权限，前端不直接执行 SQL。

## 运行

```bash
npm install
npm run tauri dev
```

浏览器 UI 预览（无数据库与导入能力）：

```bash
npm run dev
```

原生依赖：Rust stable、Node.js 20+、macOS 上的 Tauri 系统依赖（应用仅在 macOS 运行）。

> 构建注意：`public/` 会被整体复制进 `dist` 并嵌入 `.app`。测试用大文件请放在 `test-fixtures/`（已被 `*.pdf` 忽略），不要放进 `public/`；`vite.config.ts` 的 `emptyOutDir: true` 会清理历史构建产物。发布前确认 `dist` 只含 `pdfjs/` 与当前 assets，避免包体积膨胀。

## 验证

```bash
npm run build      # TypeScript + Vite 生产构建
npm run lint       # Oxlint，0 warning
npm run test       # Vitest 前端单测
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

2026-11-02 本地验证结果：

- Rust：26 项测试通过 + 1 项 Vision 真机集成测试（中文识别，需 `OCR_TEST_IMAGE`）；覆盖迁移至 v4、外键、建卡、防环、脑图移除、文档保留卡片、评分幂等、备份往返、旧备份列兼容、坏包保护等。
- 前端：13 项 Vitest 通过（归一化几何、遮挡合并、FSRS 状态映射、大纲导出、公式特征检测）。
- Tauri：release 原生编译与 `.app` 打包通过；首次启动自动建库 `quick_check=ok`。
- 界面：资料库、脑图、复习、备份四视图无头浏览器冒烟无 console error。

## 目录

```text
src/domain/              Card / Document / Review 领域类型
src/services/            类型化 Tauri invoke 边界
src/store/               单一 Card 规范化的 Zustand 内存态
src/features/library/    资料库与导入
src/features/pdf/        PDF 渲染、标注、文档回忆
src/features/mindmap/    脑图与脑图回忆
src/features/review/     FSRS 调度与复习界面
src/features/backup/     备份与恢复
src-tauri/src/           Rust 命令、数据访问、备份、文件管理
src-tauri/migrations/    SQLite schema v4（001 初始化 → 002 阅读进度 → 003 协作能力 → 004 摘录图像）
src-tauri/capabilities/  主窗口最小权限
public/pdfjs/            离线 PDF.js worker / fonts / cmaps
docs/                    架构、实施、数据恢复与已知限制
scripts/ui-smoke.mjs     Playwright 界面冒烟脚本（需 dev server）
```

## 关键设计

- Card 是唯一知识原子。PDF 高亮、脑图节点、复习闪卡只是同一 Card 的 projection。
- 内容与语义树在 `cards`，标注几何在 `annotations`，自由布局在 `mindmap_layout`，评分审计在 `review_logs`。
- 所有 SQL 在 Rust 侧执行；建卡、脑图移动、评分、文档删除和备份导入均使用显式事务。
- 评分采用 `expected_updated_at` 乐观锁 + `client_event_id` 唯一约束，避免重复计分与并发覆盖。
- PDF 副本按内容哈希命名，备份恢复前后校验每个 PDF 的 SHA-256。

## macOS 安装包

已生成并校验：

```text
release/PDFNote_0.8.0_aarch64.dmg
release/PDFNote_0.8.0_aarch64.dmg.sha256
```

该构建为 ad-hoc 签名，未做 Apple Developer 公证；首次打开可能需要在“系统设置 → 隐私与安全性”中允许。

## 重要修复

- 0.8.0 把 OCR 切换为 **Apple Vision 单引擎**：移除 Tesseract.js、WASM core 与约 63MB 离线语言模型，安装包大幅缩小；原生引擎失败时明确报错并保留选区图像，不再静默降级。详见 [Apple Vision OCR](docs/ocr.md)。

- 0.7.0 处理公式选区：纯文字 OCR 无法识别公式结构，检测到公式特征时保留选区原图（`cards.excerpt_image`），不写入乱码文本；扫描页图像摘录同样随卡片存档，脑图节点、复习闪卡与编辑器均可查看。schema 升至 v4。崩溃时错误与 React 组件栈写入 app 数据目录 `logs/crash-*.log`。

- 0.6.0 补齐标签、链接、墨迹、合并四项能力，schema 升至 v3，详见 [卡片能力](docs/card-features.md)。

- 0.5.0 新增脑图大纲模式与 Markdown 导出，详见 [大纲与导出](docs/outline-export.md)。

- 0.4.0 重构界面为“左文右图 + 悬浮工具栏”的工作台布局，详见 [工作台布局](docs/workspace-layout.md)。

- 新增“继续阅读”：每份 PDF 记录上次停留页，重新打开自动定位；旧版备份仍可导入。

- 修复进入脑图视图后 React #185（Maximum update depth）导致界面中断：选择回调改为内容比较，节点补齐 measured 尺寸。详见 [脑图崩溃复盘](docs/react-185-regression.md)。

- 修复扫描版 PDF 框选后“创建失败”：允许标注-only 建卡，并自动 OCR。

- 修复打开 PDF 后滚动会导致顶端导航栏移走：应用外壳锁定 100vh，PDF 内部 `.pdf-scroll` 成为唯一滚动容器。

- 修复 526MB / 752 页教材打开时假死：高度链导致全页渲染、备份重复压缩 PDF、asset 协议整本拉取三个根因均已处理。详见 [大文件复盘](docs/large-pdf-regression.md)。

## 文档

- [Apple Vision OCR](docs/ocr.md)
- [脑图 React #185 复盘](docs/react-185-regression.md)
- [学习工作台布局](docs/workspace-layout.md)
- [大纲模式与 Markdown 导出](docs/outline-export.md)
- [标签、链接、墨迹与合并](docs/card-features.md)

- [架构基线](docs/architecture.md)
- [实施与验收计划](docs/implementation-plan.md)
- [数据目录与备份格式](docs/data-and-backup.md)
- [已知限制](docs/known-limits.md)
- [实际验收记录](docs/acceptance.md)
