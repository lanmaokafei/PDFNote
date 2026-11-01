# 验收记录

日期：2026-11-02  
平台：macOS 26（arm64），Node 22.22、Rust 1.99、Tauri 2.12

## 自动化验证

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| Rust 数据层 | `cargo test --manifest-path src-tauri/Cargo.toml` | 17 passed + 1 ignored（Vision 集成） |
| 前端单元 | `npm run test` | 7 passed（2 files） |
| TypeScript + 打包 | `npm run build` | 通过 |
| Lint | `npm run lint` | 0 warning / 0 error |
| 原生编译 | `npx tauri build --bundles app` | 通过，生成 20.2 MB release PDFNote.app |
| DMG | 手动 `hdiutil` 打包 | 0.2.1 已通过 `hdiutil verify`，约 53 MB |
| 启动初始化 | 启动 release `.app` | 自动创建 db/pdfs/backups/tmp，`user_version=1`，`quick_check=ok` |
| UI 冒烟 | `node scripts/ui-smoke.mjs` | 4 视图无 console error / pageerror |

Rust 测试覆盖：

1. schema v1 迁移与外键/索引。
2. WAL、foreign_keys 安全设置。
3. 同内容 PDF 去重、非 PDF 拒绝、缺失/哈希不一致检测。
4. 删除文档时保留卡片、清理标注与 PDF。
5. 建卡初始化 FSRS 与脑图布局。
6. 脑图移动防环。
7. 脑图移除保留 Card 并把子节点上移。
8. 评分幂等、乐观锁冲突拒绝、Card 与日志同事务。
9. 备份导出/导入完整往返（DB + PDF + 标注）。
10. 高版本备份拒绝且不修改现有数据。
11. 覆盖恢复只保留备份中的逻辑数据。
12. bbox 约束。

前端测试覆盖：

1. bbox 归一化 clamp。
2. PDF ViewBox 解析。
3. 多标注包围盒合并。
4. 重叠判定与遮挡块传递合并。
5. FSRS 四种状态映射。
6. 调度字段与日期映射。

## P0 验收状态

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| A01 导入去重/失败清理 | 自动化通过 | 哈希去重、非 PDF 拒绝、临时文件清理路径已实现；未做 100MB 人工耗时记录 |
| A02 200 页首屏 3 秒 | 大文件实测通过（浏览器） | 526MB / 752 页元数据加载 140ms，首屏仅读 1 页；实际文件读取约 4.2MB |
| A03 建卡 100ms / 脑图 200ms | 部分验证 | 建卡单事务和前端即时刷新已实现；未做人工延迟采样 |
| A04 三视图内容一致性 | 设计保证 | 三视图订阅同一 Card store；浏览器冒烟无错误，未做多视图人工操作 |
| A05 500 标注拖拽帧率 | 未采集 | 内存态/持久态分离与 pointerup 落盘已实现；仍需 500 标注帧率采样 |
| A06 脑图语义/防环 | 自动化通过 | 防环、移除保留、子节点上移均有测试 |
| A07 评分一致与幂等 | 自动化通过 | 幂等键、乐观锁、同事务写入有测试 |
| A08 中途退出恢复 | 部分验证 | 每次评分立即提交，无内存待刷队列；未做系统强退演练 |
| A09 跨机恢复 | 自动化通过 | 新测试库从 zip 恢复 DB、PDF、标注 |
| A10 损坏包保护 | 自动化通过 | 高 schema 版本包被拒绝，现有数据不变；另有 zip 路径校验 |
| A11 完全离线 | 设计验证 | PDF.js worker/fonts/cmaps 打入 dist；业务代码无外部请求 |
| A12 全新启动 | 自动化 + 运行通过 | 首次启动建库；权限/目录不可写场景仍需人工验证 |
| 大文件 | 原生 + 浏览器实测 | 526MB / 752 页 PDF 打开不崩溃，仅请求可视页；备份改为 Stored 且后台执行 |
| 顶部栏固定 | 浏览器布局实测 | body 无滚动，内容区独立滚动，topbar top 始终为 0 |
| OCR 建卡 | Rust + 浏览器实测 | 标注-only 建卡通过；macOS Vision 中文页约 1.1 秒；Tesseract 离线模型可加载 |
| 脑图稳定性 | Chromium + IPC 模拟 | 进入脑图、选中、拖拽、PDF 建卡后切换均无 React #185 |

## 大文件回归证据

- 修复后诊断版：滚动容器 664px，752 个占位页仅 1 页相交，首屏只 `getPage(1)`。
- 浏览器 Range 压测：元数据 140ms，14 个 Range 请求共 4.2MB，第 1/376/752 页可渲染。
- 自动备份：PDF 使用 Stored；无数据变化时复用最近备份。

详见 `docs/large-pdf-regression.md`。

## 尚未完成的人工验收

- 200 页文档滚动/缩放与 500 标注拖拽的性能采样。
- 真实 PDF 的框选文字提取质量与旋转页面视觉核对。
- 系统休眠、时钟回拨、跨时区场景。
- Windows / Linux 原生构建。
- DMG/MSI/AppImage 安装与未签名提示体验。
- 崩溃注入（强杀进程）后的 WAL 恢复演练。

以上项目未标记为通过，避免把自动化覆盖误当完整验收。
