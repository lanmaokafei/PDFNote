# 验收记录

日期：2026-11-02  
平台：macOS 26（arm64），Node 22.22、Rust 1.99、Tauri 2.12

## 自动化验证

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| Rust 数据层 | `cargo test --manifest-path src-tauri/Cargo.toml -- --include-ignored` | 29 passed（含 2 项 Vision 真机：中文识别 + 行级坐标） |
| 前端单元 | `npm run test` | 25 passed（6 files，含文字层行提取与选区文本、右键菜单定位边界） |
| 在线升级冒烟（0.32.0） | `node scripts/update-smoke.mjs` | 通过：自动检测弹提示 →「稍后」记忆 → 手动检查 → 下载进度（0<%<100）→ SHA-256 校验完成 → 点击升级调起 DMG 安装器 → 已是最新/网络失败/浏览器环境三条兜底 |
| 设置按钮与模型列表（0.32.1） | `node scripts/update-smoke.mjs` 阶段 4.5 | 「检查更新」按钮高度 32px 与其他按钮一致；测试连接命中模型后仍显示「可用模型」列表 |
| 微缩导航图配色（0.32.1） | `STEP=tone ARRANGE_FOREST=1 CARD_COUNT=26` | 独立视图 26 个缩略色块 17 种色调、0 偏色，色块跟随节点节气色 |
| 安装器后自动退出（0.32.2） | `node scripts/update-smoke.mjs` | 打开安装器后提示「应用将自动退出」，约 2 秒 `quit_app` 调用 1 次 |
| 安装包启动清理（0.32.2） | `cargo test --lib update::` | 已装版本 DMG 与 `.sha256`/`.part` 删除、更新版本保留、无关文件不误删 |
| 色块主题与画布设置（0.33.0） | `STEP=style CARD_COUNT=3 STYLE_LINK=1` | 实心头背景 = 主色、字色对比度 ≥4.5、无左侧色条；深墨连线无箭头带圆点；链接虚线跟随色调、标签可隐藏；单项覆盖与重载保留 |
| 卡片盒看板（0.34.0） | `STEP=board BOARD=1 CARD_COUNT=8` | 标签/书目/状态三种分栏，空标签列保留；8 卡 10 落位、未分组 2；过滤与搜索正确；拖 c1 到空标签列后 `set_card_tags` 收到 `[空标签]`；点卡片回到原文 |
| 文档回忆藏手写与留白（0.34.0） | `STEP=recall RECALL_SEED=1 CARD_COUNT=3` | 回忆态墨迹 1→0、留白 1→0、遮挡块 1；退出后恢复 1/1 |
| 文字层冒烟 | `node scripts/textlayer-smoke.mjs` | 通过：透明 DOM 文字可原生拖选「信息系统项目管」，选区 bbox 换算正确 |
| 右键菜单冒烟 | `node scripts/contextmenu-smoke.mjs` | 通过：原生 Reload 菜单被接管、菜单项执行动作、右下角翻转、键盘导航、输入框保留系统菜单、选区读取与跨层判定 |
| TypeScript + 打包 | `npm run build` | 通过 |
| Lint | `npm run lint` | 0 warning / 0 error |
| 原生编译 | `npx tauri build --bundles app` | 通过，0.19.0 生成 release PDFNote.app |
| DMG | 手动 `hdiutil` 打包 | 0.19.0 已通过 `hdiutil verify`；卷内含 `Applications -> /Applications` 快捷方式，SHA-256 见 `release/*.sha256` |
| 启动初始化 | 启动 release `.app` | 自动创建 db/pdfs/backups/tmp，`user_version=5`，`quick_check=ok` |
| schema 迁移 | 真实数据库副本执行 v4 → v5 | `page_ocr` 表建立，5 张卡片 / 1 个文档保留，`quick_check=ok`（真实库已是 v4） |
| UI 冒烟 | `node scripts/ui-smoke.mjs` | 4 视图无 console error / pageerror |
| 橡皮大小与连擦（0.31.0） | `STEP=ink-erase CARD_COUNT=3` | 4 档大小；特大光标 r=56；悬停命中高亮；拖动一次擦掉两条线，前后端 0 残留 |
| 卡片配色面板（0.30.0） | `STEP=style CARD_COUNT=3` | 面板顶部 24 色块；点色块卡片变色并落盘；「跟随子树」恢复自动分配 |
| 卡片样式主题（0.29.0） | `STEP=style CARD_COUNT=3` | 右键 → 样式面板；墨色卡面 `rgb(36,41,37)`、自定义 14px/宽松、换主题清覆盖、重载保留 |
| AI 解析覆盖所有卡片（0.28.0） | `NO_QUESTION=1 STEP=explain CARD_COUNT=3` | 3 张卡都有按钮；只有摘录的卡可用并写回笔记（1115 字）；无 question 的提示文案指向摘录；三者全空的卡禁用 |
| 卡片配色（0.27.0） | `STEP=tone ARRANGE_FOREST=1 CARD_COUNT=26` | 26 张独立卡片 17 种色调、无缺失；点徽标换色并写入 localStorage；低倍 lite 保留 17 种色 |
| 文字层几何（0.26.0） | `STEP=textlayer CARD_COUNT=3` | 字号比例 = 12/792（±2%）、全部行按 run 渲染、选区覆盖字形；真实《弱传播》第 7 页逐行重合 |
| 每本书自带画布（0.25.0） | `EMPTY_DOC_CANVAS=1 STEP=doc-canvas` | 无专属画布时补建并以书名命名、自动选中、写入偏好，重开文档复用同一张 |
| 新卡落点（0.24.0） | `STEP=insert-center CARD_COUNT=3 node scripts/mindmap-regression.mjs` | 平移后新建两张卡：第一张 = 视口中心 − 127/95（±3px），第二张右移 36px；无固定坐标 |
| 低缩放拖拽（0.23.0） | `STEP=zoom-drag DENSE=1 CARD_COUNT=1483 node scripts/mindmap-regression.mjs` | 338 节点同屏，重渲染 0 次（原 7,887）、最长帧 47ms（原 247ms）、长任务 0（原 6）、DOM 1,310（原 26,709） |
| 大画布性能（0.22.0） | `STEP=perf CARD_COUNT=1483 node scripts/mindmap-regression.mjs` | 首节点 898ms（原 8437ms）、DOM 474（原 33745）、堆 60MB（原 215MB）；>200 卡时断言挂载节点 ≤80 |

Rust 测试覆盖：

1. schema v1 → v2 → … → v8 → v9 迁移（阅读进度、标签/链接/墨迹、摘录图像、页面文字缓存、标题链接别名、留白、拆书、多画布）、外键与索引。
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
| 主动回忆输入与答案对比反馈（0.21.0） | Vitest + 无头 Chrome | `answerMatch.test.ts` 13 项通过（HTML / 全角 / LaTeX 归一化、中英文完全一致、加权 F1 分档、要点命中与待补、空输入不泄露、无文字答案优先、无关输入、整章粘贴惩罚、要点去重）；`node scripts/review-answer-smoke.mjs` 验证静态提示已移除、揭示前不渲染反馈且不出现「能量工厂」、`Ctrl+Enter` 揭示、完整答案 100%「很接近」、改成无关输入后实时变差、清空回落「未输入」且不泄露要点、部分答案命中「线粒体」并提示「货币」、评分后切到第二张卡且输入与反馈复位、无文字答案显示降级反馈；`cargo test --lib` 77 项、Vitest 91 项、tsc / Oxlint / 18 个脑图回归场景全绿 |
| 多画布与 AnkiDroid 导入（0.20.0） | Rust + Vitest + 无头 Chrome + 真实导出 | `cargo test --lib` 77 项通过（画布 CRUD、按画布移除/清空、拆书写第二画布、两种 txt 格式、HTML 清洗、建树、幂等导入、牌组筛选、跨格式答案补齐）；`ANKI_FIXTURE_PATH` 校验两份真实 AnkiDroid 导出各 1455 张卡；`STEP=canvas` 验证默认画布 3 张 / 本书 A 2 张 / 本书 B 1 张、切换时 React Flow DOM 探针保持、新建绑定 doc1、重命名、删除回落 main 且卡片恢复；`STEP=anki` 验证预览 3 张 / 2 牌组、取消勾选后计数变 2、导入写入 `doc-canvas` 且 `main` 成员不被污染；`STEP=all CARD_COUNT=120` 与其余 15 个既有场景全绿 |
| 卡片笔记展开与滚动（0.19.0） | Vitest + 无头 Chrome | `isClampable` 4 项（短文本、多段 AI 解析、超长单段、公式不折叠）；`STEP=note-expand` 实测 AI 解析写回后自动展开（1115 字完整渲染）、`line-clamp: none` + `overflow-y: auto` + 170px 限高（内容 711px）、滚轮滚动 200px 且 viewport transform 不变、收起恢复折叠、点击正文再展开、大纲行显示并可展开笔记；`STEP=math` 复验公式仍不被裁切 |
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
