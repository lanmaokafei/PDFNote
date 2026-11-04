# 验收记录

日期：2026-11-02  
平台：macOS 26（arm64），Node 22.22、Rust 1.99、Tauri 2.12

## 自动化验证

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| Rust 数据层 | `cargo test --manifest-path src-tauri/Cargo.toml -- --include-ignored` | 29 passed（含 2 项 Vision 真机：中文识别 + 行级坐标） |
| 前端单元 | `npm run test` | 25 passed（6 files，含文字层行提取与选区文本、右键菜单定位边界） |
| 文字层冒烟 | `node scripts/textlayer-smoke.mjs` | 通过：透明 DOM 文字可原生拖选「信息系统项目管」，选区 bbox 换算正确 |
| 右键菜单冒烟 | `node scripts/contextmenu-smoke.mjs` | 通过：原生 Reload 菜单被接管、菜单项执行动作、右下角翻转、键盘导航、输入框保留系统菜单、选区读取与跨层判定 |
| TypeScript + 打包 | `npm run build` | 通过 |
| Lint | `npm run lint` | 0 warning / 0 error |
| 原生编译 | `npx tauri build --bundles app` | 通过，0.18.0 生成 release PDFNote.app |
| DMG | 手动 `hdiutil` 打包 | 0.18.0 已通过 `hdiutil verify`；卷内含 `Applications -> /Applications` 快捷方式，SHA-256 见 `release/*.sha256` |
| 启动初始化 | 启动 release `.app` | 自动创建 db/pdfs/backups/tmp，`user_version=5`，`quick_check=ok` |
| schema 迁移 | 真实数据库副本执行 v4 → v5 | `page_ocr` 表建立，5 张卡片 / 1 个文档保留，`quick_check=ok`（真实库已是 v4） |
| UI 冒烟 | `node scripts/ui-smoke.mjs` | 4 视图无 console error / pageerror |

Rust 测试覆盖：

1. schema v1 → v2 → v3 → v4 → v5 → v6 → v7 → v8 迁移（阅读进度、标签/链接/墨迹、摘录图像、页面文字缓存、标题链接别名、留白、拆书）、外键与索引。
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
7. 右键菜单定位：常规位置、右/下边缘翻转、超大菜单 clamp、非有限坐标（6 项）。

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
| A11 完全离线 | 设计验证 | PDF.js worker/fonts/cmaps 打入 dist；OCR 用系统 Apple Vision，不打包离线模型；业务代码无外部请求 |
| A12 全新启动 | 自动化 + 运行通过 | 首次启动建库；权限/目录不可写场景仍需人工验证 |
| 大文件 | 原生 + 浏览器实测 | 526MB / 752 页 PDF 打开不崩溃，仅请求可视页；备份改为 Stored 且后台执行 |
| 顶部栏固定 | 浏览器布局实测 | body 无滚动，内容区独立滚动，topbar top 始终为 0 |
| OCR 建卡 | Rust 真机 + 浏览器实测 | 标注-only 建卡通过；0.8.0 起为 Apple Vision 单引擎，真机中文图识别出「信息化」；已移除 Tesseract 与 63MB 离线模型 |
| 可选文字层（0.9.0） | Rust 真机 + 无头 Chrome | 4 行中文图返回归一化行坐标（2.81s）；缓存往返与旧备份兼容测试通过；透明 DOM 文字拖选精确到字符，可复制/建卡；0.10.1 起选区字形保持透明（`::selection` color/fill 均为 `rgba(0,0,0,0)`），与 PDF 原字无重影 |
| 元素右键菜单（0.10.0） | Vitest + 无头 Chrome | 原生 Reload 菜单被接管；文字选区/标注/墨迹/脑图节点/文档卡片按元素给菜单；动作执行、边界翻转、ESC 与键盘导航、输入框系统菜单均通过 |
| 可设拆分层级（0.18.0） | Vitest + Rust + 无头 Chrome | 默认 2 层、4 层偏好写入 localStorage 且刷新后仍生效；阶段一/阶段二命令均收到 `depth=4`；预览渲染到 L4、统计 4 节点 4 层；写入 4 张卡片；改回 2 层后旧骨架失效且命令参数同步；Rust 覆盖 depth 收敛、按层截断、提示词嵌套示例、旧 `outline_json` 兼容、4 层父子链与 x=0/320/640/960 布局 |
| 脑图整理与清空（0.17.0） | Vitest + Rust + 无头 Chrome | 26 张独立卡片整理成紧凑网格（长宽比 / 不重叠 / 缩放 ≥ 0.2）、整理后命令调用与坐标落库；清空对话框两种模式往返、remove 保留卡片、delete 清空节点与卡片；Rust 覆盖级联清理与非法模式拒绝 |
| 拆书卡片回跳与 AI 解析（0.16.0） | Rust + 无头 Chrome | 页码标签渲染、点击派发跳页事件、AI 解析调用模型并写回笔记、分组节点继承来源页、大纲切回画布实例不卸载 |
| AI 拆书（0.15.0） | Rust + 无头 Chrome | JSON 容错（围栏/前后说明）、页码越界丢弃、骨架写入卡片+布局并去重、不生成 annotation、深度与节点上限；冒烟走完分析→汇总→写入并校验分块笔记落库 |
| 留白（0.14.0） | Rust + 无头 Chrome | 增删改查往返、非法输入拒绝、文档删除级联清除、v6→v7 迁移；冒烟覆盖右键添加 → 输入失焦保存 → 折叠 → 展开 → 删除 |
| 公式不被裁切（0.13.2） | 无头 Chrome 实测 + 截图 | 段落 `scrollHeight = clientHeight`（原 3 行 clamp 已解除）、公式容器 `scrollWidth = clientWidth`（自适应缩放生效）、卡片整体无纵向溢出；截图确认公式完整可读 |
| 公式卡不显示截图（0.13.1） | Vitest + 无头 Chrome | `hasMathContent` 3 项（裸公式、行内公式、纯文本/空）；脑图实测公式节点截图 0 张、纯图片卡片仍有 2 张 |
| 公式渲染与画布平移（0.13.0） | Vitest + 无头 Chrome | 裸 LaTeX、`$...$` 混排、普通中英文文本判定共 9 项；脑图渲染出 `.katex` 与 display 模式、字体 `KaTeX_Main` 加载成功；左键拖空白与滚轮均改变 viewport transform（旧版不动） |
| `result_text` 与失败交互（0.12.7） | Rust mock + Vitest | 真实网关响应体（`result_text` + `events`）解析为 LaTeX 且不误取状态/时间戳；未知字段 `answer_text` 走兜底；前端摘要 ≤40 字、详情含任务号与补救指引，重试/详情按钮渲染 |
| Mathpix 提示词与任务取回（0.12.6） | Rust mock + 无头 Chrome | 提示词含「先判断是否有公式 / Mathpix / 无公式输出文字」；解析 `code+data.status+data.latex`、`content` 分段数组、`result.output`，状态词不会被当结果；查询地址含 `/api/v1/tasks` 候选；`fetch_task_result` 用已保存配置取回 `H = -\\sum...`；设置面板任务号取回入口冒烟通过 |
| 网关超时轮询（0.12.5） | Rust mock | 504 错误体中的任务号可解析（文本与结构化两种）；自动 `GET /tasks/{id}` 取回并清洗结果；轮询失败保留任务号；超时可配置 30–300 秒 |
| 删卡标注联动（0.12.4） | Vitest + 无头 Chrome | 跨页清理、非命中页复用引用、空缓存共 4 项；mock IPC 下脑图删卡后 PDF 标注 1 → 0 并提示“已同步移除”；后端返回 `annotation not found` 时自愈移除、不再报删除失败 |
| 安装包签名（0.12.3） | `codesign` | `Identifier=com.pdfnote.local`、`Info.plist entries=14`、`Sealed Resources files=1`；`codesign --verify --strict` 通过（未公证，`spctl` 仍 rejected 属预期） |
| 右键折叠（0.12.2） | Vitest + 无头 Chrome | 折叠根节点隐藏整棵子树、孤儿与环仍可见；mock IPC 下右键「折叠子节点」使画布节点数确实减少 |
| 模型连通性（0.12.2） | Rust mock + 无头 Chrome | `GET /models` 返回延迟/模型列表并校验模型名；500 报错、404 退化到最小对话请求；设置面板按钮与失败反馈通过 |
| 脑图 #185（0.12.1） | 无头 Chrome + mock IPC | 120 节点下「切大纲」修复前必崩、修复后正常；折叠/展开、拖拽落盘、连续 resize、单选与 Meta 多选全部通过 |
| 可选 AI 识别（0.12.0） | Rust + 无头 Chrome | 设置往返/校验/围栏清理/未配置不发请求通过；本地 mock 服务验证 POST 路径、Bearer、model、图像字段与 500 报错；设置面板冒烟通过 |
| 标题链接（0.11.0） | Vitest + 无头 Chrome | 10 项匹配测试通过（中文/别名/词边界/多卡聚合/长句过滤）；浏览器冒烟验证「心肌梗死」「STEMI」「MI」命中，高亮条 top/height 与行框一致（0.1 / 0.03），`XSTEMIX` 不误命中；schema v6 迁移与 v5 备份补空别名通过 |
| 脑图稳定性 | Chromium + IPC 模拟 | 进入脑图、选中、拖拽、PDF 建卡后切换均无 React #185 |
| 继续阅读 | Chromium + IPC 模拟 | 5 页文档记录第 4 页，重开落在第 4 页；滚到第 3 页后返回重开仍为第 3 页 |
| 分栏工作台 | Chromium + IPC 模拟 | 左 PDF 右脑图、11 个工具槽、拖动分隔条、脑图收起、工具坞建卡均通过 |
| 大纲与导出 | 单元 + Rust + Chromium | 5 行大纲、折叠后 2 行；Markdown 层级/摘录/页码正确；`.md` 写入通过、`.txt` 被拒 |
| 标签 | Rust + Chromium | 去重/长度校验；保存后脑图节点显示标签 |
| 链接 | Rust + Chromium | 幂等建链、禁自链；脑图出现虚线链接边 |
| 墨迹 | Rust + Chromium | 笔画归一化落库、橡皮删除；缩放后对齐 |
| 合并 | Rust + Chromium | 文本/子节点/标注/标签合并，3 张合为 1 张；跨文档合并被拒 |

## 大文件回归证据

- 修复后诊断版：滚动容器 664px，752 个占位页仅 1 页相交，首屏只 `getPage(1)`。
- 浏览器 Range 压测：元数据 140ms，14 个 Range 请求共 4.2MB，第 1/376/752 页可渲染。
- 自动备份：PDF 使用 Stored；无数据变化时复用最近备份。

详见 `docs/large-pdf-regression.md`。

## 尚未完成的人工验收

- 200 页文档滚动/缩放与 500 标注拖拽的性能采样。
- 真实 PDF 的框选文字提取质量与旋转页面视觉核对。
- 系统休眠、时钟回拨、跨时区场景。
- Windows / Linux 不在交付范围内（用户明确仅 macOS），OCR 依赖 Apple Vision，不做跨平台原生实现。
- DMG 安装与未签名提示体验。
- 崩溃注入（强杀进程）后的 WAL 恢复演练。

以上项目未标记为通过，避免把自动化覆盖误当完整验收。
