# PDFNote

本地优先、卡片轴心的 PDF 学习应用：在 PDF 上框选摘录即生成卡片，同一张卡片同时作为脑图节点和 FSRS 闪卡使用。

技术栈：Tauri v2 + React 19 + TypeScript + Vite + SQLite + PDF.js + ts-fsrs + React Flow。

## 已实现

- **本地资料库**：PDF 选择导入、SHA-256 去重、应用数据目录副本、断链检测、哈希一致性校验、重新定位、删除时保留或级联删除卡片。
- **PDF 工作区**：PDF.js 连续滚动与页级虚拟化、256KB Range 分块读取、缩放、页码跳转、高亮/矩形框选建卡、区域文字近似提取、标注拖拽、标注删除语义选择、文档遮挡主动回忆。
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

原生依赖：Rust stable、Node.js 20+、各平台 Tauri 系统依赖。

## 验证

```bash
npm run build      # TypeScript + Vite 生产构建
npm run lint       # Oxlint，0 warning
npm run test       # Vitest 前端单测
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build
```

2026-11-02 本地验证结果：

- Rust：16 项测试通过（迁移、外键、建卡、防环、脑图移除、文档保留卡片、评分幂等、备份往返、坏包保护等）。
- 前端：7 项 Vitest 通过（归一化几何、遮挡合并、FSRS 状态映射）。
- Tauri：debug 原生编译与 `.app` 打包通过；首次启动自动建库 `quick_check=ok`。
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
src-tauri/migrations/    SQLite schema v1
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
release/PDFNote_0.1.1_aarch64.dmg
release/PDFNote_0.1.1_aarch64.dmg.sha256
```

该构建为 ad-hoc 签名，未做 Apple Developer 公证；首次打开可能需要在“系统设置 → 隐私与安全性”中允许。

## 重要修复

- 修复 526MB / 752 页教材打开时假死：高度链导致全页渲染、备份重复压缩 PDF、asset 协议整本拉取三个根因均已处理。详见 [大文件复盘](docs/large-pdf-regression.md)。

## 文档

- [架构基线](docs/architecture.md)
- [实施与验收计划](docs/implementation-plan.md)
- [数据目录与备份格式](docs/data-and-backup.md)
- [已知限制](docs/known-limits.md)
- [实际验收记录](docs/acceptance.md)
