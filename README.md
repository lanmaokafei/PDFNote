# PDFNote

本地优先、卡片轴心的 PDF 学习应用：在 PDF 上框选摘录即生成卡片，同一张卡片同时作为脑图节点和 FSRS 闪卡使用。

技术栈：Tauri v2 + React 19 + TypeScript + Vite + SQLite + PDF.js + ts-fsrs + React Flow。

## 已实现

- **本地资料库**：PDF 选择导入、SHA-256 去重、应用数据目录副本、断链检测、哈希一致性校验、重新定位、删除时保留或级联删除卡片。
- **同屏工作台**：左 PDF、右脑图，顶部悬浮分段栏，底部工具坞；分栏可拖动，脑图可一键收起。
- **PDF 工作区**：PDF.js 连续滚动与页级虚拟化、256KB Range 分块读取、缩放、页码跳转、自动回到上次阅读页、高亮/矩形框选建卡、文字层提取、Apple Vision OCR、标注拖拽、标注删除语义选择、文档遮挡主动回忆。
- **可选文字层（0.9.0）**：切到「文字」工具后可像 Word 一样在页面上随手拖选文字，选中即复制或直接建卡。页面打开时后台整页识别一次（有 PDF 文字层则用精确字形坐标，扫描页用 Apple Vision 行级 OCR），结果带每行坐标并缓存到 SQLite，之后所有点选/框选零延迟。详见 [Apple Vision OCR](docs/ocr.md)。
- **元素右键菜单（0.10.0）**：接管 WKWebView 只有 Reload 的原生右键菜单。选中文字可复制/引用/建卡，标注可加标签、链接、合并、删除，墨迹可单条删除，页面空白处可切工具、缩放、翻页、复制本页文字；脑图节点、资料库文档、复习卡片与全局空白区也都有对应操作。详见 [应用内右键菜单](docs/context-menu.md)。
- **可设拆分层级（0.18.0）**：AI 拆书向导新增「拆分层级」，默认 2 层、可选 1–5 层；选 4 层就能把「章 → 小节 → 名词 → 解释」一次拆出来，阶段一多抽名词定义、阶段二按层生成骨架，设置会记住。详见 [AI 拆书](docs/ai-book-digest.md)。
- **脑图自动整理与清空卡片（0.17.0）**：多张独立卡片不再堆成细长竖条，而是打包成紧凑网格并在整理后自动对齐视口；工具栏新增「清空卡片」，可选择「仅清空脑图」或「彻底删除」。详见 [脑图自动整理与清空卡片](docs/mindmap-layout.md)。
- **拆书卡片回跳与 AI 解析（0.16.0）**：拆书生成的卡片带 `P3` 来源页码标签，点一下左侧 PDF 自动跳到对应页；带 Q 的卡片可直接「AI 解析」，模型按「是什么 / 为什么 / 怎么用 / 易错点」写回笔记。分组节点无页码时自动继承子节点页码。
- **AI 拆书（0.15.0）**：一键把论文 / 教材拆成问题驱动的脑图骨架。分块抽笔记 → 汇总层级 → 写入卡片，每个节点带原文摘录与页码；四种姿态：结构（背景/方法/结果/讨论）、智能词典（术语喂标题链接）、英文生词（CEFR 分级）、题目（自测问题）。100 页以上可中断续跑。详见 [AI 拆书](docs/ai-book-digest.md)。
- **留白（0.14.0）**：页面空白处右键即可在页边贴一张独立草稿，不绑定任何文字；失焦自动保存，可折叠成边缘小圆点或删除。适合记录「这一段暂时用不上、但以后可能有用」的想法。详见 [留白：页边草稿](docs/page-notes.md)。
- **公式渲染（0.13.0）**：卡片摘录里的 LaTeX 会在脑图节点、大纲、复习卡背面直接排版显示；裸 LaTeX（AI 识别的常见输出）也能自动识别，混排文本里的 `$...$` 同样生效。渲染完全本地（离线 KaTeX），原始 LaTeX 始终保留可编辑。详见 [公式渲染](docs/math-rendering.md)。
- **可选 AI 识别（0.12.0）**：顶栏齿轮里可配置 OpenAI 兼容的视觉模型（本机 Ollama / LM Studio 或自填云端 Key）。配置后，扫描页的**公式选区**自动转成 LaTeX 写入卡片摘录，原图仍保留对照；未配置时应用完全不联网，公式照旧「原图 + 手动补录」。详见 [可选 AI 识别](docs/ai-recognition.md)。
- **标题链接（0.11.0）**：卡片标题与别名自动注册为关键词，读到任意文档时页面中命中的词会高亮，点击即可回看当年那张卡的摘录、笔记与来源。纯本地 Aho-Corasick 字典匹配，不走 AI、不联网；默认关闭，卡片库积累后开启。详见 [标题链接](docs/title-link.md)。
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
npm run dev                      # 默认 http://localhost:1420
npm run dev -- --host 127.0.0.1  # 跑冒烟脚本时用这个（脚本访问 127.0.0.1）
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

- Rust：61 项测试通过（含 2 项 Vision 真机集成：`OCR_TEST_IMAGE` 中文识别、`OCR_PAGE_TEST_IMAGE` 行级坐标）；覆盖迁移至 v8、外键、建卡、防环、脑图移除、文档保留卡片、评分幂等、备份往返、旧备份列兼容、页面文字缓存、坏包保护、视觉模型设置/连通性测试、任务号解析与异步结果取回、本地 mock 端到端识别、留白增删改查与级联删除、拆书 JSON 容错与骨架写入、分组节点继承来源页、批量清空的两种模式与级联清理等。
- 前端：67 项 Vitest 通过（归一化几何、遮挡合并、FSRS 状态映射、大纲导出、脑图折叠可见性、标注缓存联动清理、公式特征检测与决策、LaTeX 检测与切分（含公式内容判定）、识别失败摘要与任务号提取、文字层行提取与选区文本、右键菜单定位边界、标题链接字典与匹配）。
- 设置面板冒烟：`node scripts/settings-smoke.mjs`（需 dev server），验证模型配置对话框字段、非桌面环境提示与关闭。
- 脑图稳定性回归：`CARD_COUNT=120 STEP=all node scripts/mindmap-regression.mjs`（需 dev server），覆盖大纲往返、折叠展开、拖拽落盘、连续 resize 与单选/多选，专治 React #185。
- 文字层冒烟：`node scripts/textlayer-smoke.mjs`，用无头 Chrome 验证透明 DOM 文字可原生拖选并换算出归一化选区。
- 右键菜单冒烟：`node scripts/contextmenu-smoke.mjs`（需 dev server），验证原生菜单接管、菜单项动作、边界翻转、键盘导航、输入框保留系统菜单与选区读取。
- 标题链接冒烟：`node scripts/titlelink-smoke.mjs`（需 dev server），在真实浏览器加载模块，验证中文/别名命中、拉丁词边界、多卡聚合与高亮条归一化坐标。
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
src-tauri/migrations/    SQLite schema v8（001 初始化 → 002 阅读进度 → 003 协作能力 → 004 摘录图像 → 005 页面文字缓存 → 006 标题链接别名 → 007 留白 → 008 拆书）
src-tauri/capabilities/  主窗口最小权限
public/pdfjs/            离线 PDF.js worker / fonts / cmaps
docs/                    架构、实施、数据恢复与已知限制
scripts/ui-smoke.mjs           Playwright 界面冒烟脚本（需 dev server）
scripts/contextmenu-smoke.mjs  右键菜单冒烟脚本（需 dev server）
scripts/titlelink-smoke.mjs    标题链接匹配与高亮定位冒烟（需 dev server）
scripts/settings-smoke.mjs     设置面板冒烟（需 dev server）
scripts/mindmap-regression.mjs 脑图 React #185 回归（需 dev server）
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
release/PDFNote_0.18.0_aarch64.dmg
release/PDFNote_0.18.0_aarch64.dmg.sha256
```

该构建为 ad-hoc 签名，未做 Apple Developer 公证；首次打开可能需要在“系统设置 → 隐私与安全性”中允许。

DMG 内已放置 **Applications 快捷方式**：打开镜像后把 PDFNote 拖进「应用程序」即可完成安装（打包时用 staging 目录 + `ln -s /Applications`，再 `hdiutil create -srcfolder`）。

打包完成后记得取消注册构建目录里的副本，否则它会和 `/Applications` 抢 LaunchServices 的“主副本”，表现为启动台 / 应用程序面板里看不到图标：

```bash
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
$LSREG -u src-tauri/target/release/bundle/macos/PDFNote.app
$LSREG -f /Applications/PDFNote.app
killall Dock
```

安装后如遇以下情况：

- **启动台 / 应用程序面板里看不到图标**（Spotlight 能搜到、也能打开）：说明 LaunchServices 里登记了多个同 bundle id 的副本（构建产物、已卸载的 DMG 卷），系统把“主副本”指到了不存在或开发目录的路径。按顺序执行：

```bash
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
$LSREG -dump | grep "PDFNote.app"          # 看有哪些残留路径
$LSREG -u "/Volumes/PDFNote/PDFNote.app"   # 逐个取消（换成上面列出的路径）
$LSREG -u src-tauri/target/release/bundle/macos/PDFNote.app
$LSREG -f /Applications/PDFNote.app        # 安装副本重新登记
killall Dock
```

  之后 `lsregister -dump | grep PDFNote.app` 应只剩 `/Applications/PDFNote.app`，`open -a PDFNote` 会启动安装版。

- **首次打开提示“无法验证开发者”**：这是未做 Apple 公证的正常结果。在「应用程序」里右键 PDFNote → 打开，或到「系统设置 → 隐私与安全性」点“仍要打开”。
- **已经装了旧版本**（0.12.2 及更早）导致 Launchpad 异常：旧包是链接器自动签名，bundle 资源未封印。用新版覆盖，或手动修复已安装副本：

```bash
codesign --force --deep --sign - --identifier com.pdfnote.local /Applications/PDFNote.app
xattr -dr com.apple.quarantine /Applications/PDFNote.app
killall Dock
```

## 重要修复

- 0.18.0 新增**可设 AI 拆分层级**（默认 2 层，1–5 层，偏好持久化）：解决厚书「一章多小节、小节多名词、名词还有解释」只能拆出两层的问题。阶段一/阶段二提示词、节点预算、解析截断与父子卡片布局都随层数联动。

- 0.17.0 修复**自动整理后卡片散落且缩放过小**（森林网格打包 + 整理后 fitView）；新增**批量清空脑图卡片**（仅移出脑图 / 彻底删除，单事务、带确认框）。

- 0.16.0 修复**大纲切回画布后卡片空白**（画布改为常驻，大纲只是覆盖层，不再卸载重建 React Flow）；新增**拆书卡片页码标签 + 点击跳回原文**、**卡片 AI 解析问题**（结果写入笔记）。

- 0.15.0 新增 **AI 拆书**：分块抽取（结构 / 智能词典 / 英文生词 / 题目四种模式）→ 汇总成层级骨架 → 批量写入卡片与脑图；节点保留原文摘录与页码，可回跳来源。两阶段都落库，超过 100 页可中断续跑。

- 0.14.0 新增**留白（页边草稿）**：右键页面空白添加，贴在页面右边缘，失焦保存、可折叠/删除；数据存 `page_notes`（schema v7），随备份往返并参与合并导入。

- 0.13.2 修复**卡片里的公式被裁掉**：卡片正文原本按 3 行截断（`-webkit-line-clamp`），块级公式高度远超 3 行，右侧和下半部分会被切掉。现在含公式的段落自动取消截断，公式按卡片宽度等比缩放（基准 11px，下限 70%），过长时才横向滚动。

- 0.13.1 修正**公式卡片重复显示**：摘录已经能排版成公式时，不再显示选区截图，避免图片挤占空间把公式遮住；纯图片卡片（OCR 没取到文字）仍保留截图。

- 0.13.0 新增**公式渲染**：KaTeX 本地渲染卡片里的 LaTeX（脑图节点、大纲、复习卡背面），裸 LaTeX 与 `$...$` 混排都能识别，原始源码保留可编辑。同时修正脑图画布导航：**左键拖空白即可平移**、触控板双指滑动平移、`⌘`+滚轮或捏合缩放，框选改为按住 `Shift`。

- 0.12.7 修好**任务结果取不回来**：本机网关把识别结果放在 `result_text`，此前解析器只认 `latex`/`content`/`result`，于是明明 `SUCCEEDED` 却轮询到超时。现在 `result_text` 优先解析，并加了“最长非元数据字符串”兜底，网关改字段名也能取到。识别失败的状态栏改为**一句摘要 + 重试按钮 + 默认折叠的「查看详情」**，详情里可复制完整错误与任务号。

- 0.12.6 让公式识别真正对齐 Mathpix：提示词先判断图片中是否存在科学公式，有公式则输出 Mathpix 兼容 LaTeX（保留 `\frac`、`\sum_{i=1}^{n}`、`\log_2`、上下标结构），无公式则输出文字。网关 504 后的任务结果解析更宽容（`data.latex`、嵌套 `content` 数组、`result.output` 等），首次立即查询；设置面板新增「按任务号取回结果」，可对已完成任务直接取回 LaTeX 并复制。

- 0.12.5 处理**网关 504 超时**：当服务端在自己的 90 秒上限先返回 504 并给出异步任务号时，应用会自动轮询 `/tasks/{task_no}` 取回识别结果，而不是直接失败；设置面板新增可调超时（30–300 秒），提示文案也改用实际配置值。

- 0.12.4 修复**脑图删卡后 PDF 标注不联动**：卡片删除后 PDF 工作区的标注缓存仍是旧值，页面上留下点不掉的“幽灵标注”，点击删除报 `annotation not found`。现在卡片删除会广播事件，PDF 立即清理对应标注并让相关页重新对齐；后端已无此标注时也不再报错，而是自愈移除并说明。

- 0.12.3 修复**安装后 Launchpad 找不到图标**：此前 Tauri 产物只有链接器自动签名（`Identifier` 与 bundle id 不一致、`Info.plist` 未绑定、资源未封印），LaunchServices 无法正确注册。现在 `bundle.macOS.signingIdentity` 固定为 `-`，每次构建都对整个 bundle 做 ad-hoc 签名并封印资源（`codesign --verify --strict` 通过）。

- 0.12.2 修复**画布右键折叠节点不生效**：可见性算法的兜底循环把被折叠的子节点又加了回来。同时：设置面板新增「测试连接」（验证地址、鉴权与模型名）；公式识别不再只覆盖 OCR 来源，文字层公式也会走视觉模型，并带秒级进度与 120 秒超时提示。

- 0.12.1 修复**切「大纲」必崩的 React #185**：受控 nodes 下选择回调在 React Flow 更新阶段同步 setState，形成更新回路。选择改由 `select` change 驱动并合并到下一帧；拖拽中不回写位置；测量回写加容差与熔断；React Flow 的对象/数组 prop 全部常量化。新增 `scripts/mindmap-regression.mjs` 作为回归红线。详见 [React #185 复盘](docs/react-185-regression.md)。

- 0.12.0 新增**可选 AI 识别**：公式选区可交给配置好的视觉模型转 LaTeX，默认不配置即完全离线；设置文件独立于数据库与备份包。详见 [可选 AI 识别](docs/ai-recognition.md)。

- 0.11.0 新增**标题链接**：卡片标题与别名成为本地关键词字典，阅读任意文档时命中词自动高亮，点击回看原卡片并跳回来源页。schema 升至 v6（`cards.link_aliases`），旧备份导入时自动补空别名。详见 [标题链接](docs/title-link.md)。

- 0.10.1 修复**文字选区重影**：选区高亮此前会把文字层里被拉伸的 DOM 字形一并画出来，与 PDF 真实字形错位形成“双层文字”。现在选区只绘制半透明底色，字形始终保持透明。
- 0.10.0 用**应用内右键菜单**替代 WKWebView 只有 Reload 的原生菜单：按选中的文字、标注、墨迹、脑图节点等元素提供就地操作；输入框仍保留系统复制/粘贴菜单。详见 [应用内右键菜单](docs/context-menu.md)。

- 0.9.0 加入**可选文字层**：Apple Vision 返回的每行坐标不再丢弃，整页识别一次后铺成透明 DOM 文字层并缓存到 SQLite（`page_ocr`，schema v5）。「文字」工具下可像 Word 一样拖选、复制、建卡；框选建卡也优先读缓存文字，不再每次等待 OCR。有 PDF 文字层的页面直接用精确字形坐标，完全不走 OCR。
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

- [应用内右键菜单](docs/context-menu.md)
- [脑图自动整理与清空卡片](docs/mindmap-layout.md)
- [AI 拆书](docs/ai-book-digest.md)
- [留白：页边草稿](docs/page-notes.md)
- [公式渲染与脑图画布导航](docs/math-rendering.md)
- [可选 AI 识别](docs/ai-recognition.md)
- [标题链接](docs/title-link.md)
- [Apple Vision OCR 与可选文字层](docs/ocr.md)
- [脑图 React #185 复盘](docs/react-185-regression.md)
- [学习工作台布局](docs/workspace-layout.md)
- [大纲模式与 Markdown 导出](docs/outline-export.md)
- [标签、链接、墨迹与合并](docs/card-features.md)

- [架构基线](docs/architecture.md)
- [实施与验收计划](docs/implementation-plan.md)
- [数据目录与备份格式](docs/data-and-backup.md)
- [已知限制](docs/known-limits.md)
- [实际验收记录](docs/acceptance.md)
