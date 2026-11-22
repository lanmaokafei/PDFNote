# 跨库统一搜索（0.64.0）

`⌘K` 或顶栏放大镜打开：一次搜 **文档标题 / 卡片内容 / 笔记本标题**。

## 交互

- 输入即搜（130ms 防抖），结果按「卡片 → 文档 → 笔记本」分组，右侧标出跳转目标（`P3` / `文档` / `脑图`）。
- `↑` `↓` 选择，`↵` 打开，`esc` 关闭（焦点不在输入框也能关）。
- 空输入给一句说明；无结果显示「没有找到「xxx」」。
- 回收站里的卡片与文档不会出现在结果里。

## 跳转规则

| 结果 | 行为 |
| --- | --- |
| 文档 | 派发 `pdfnote:open-source`，App 设 activeDocument + jumpTarget → 直接进文档工作区 |
| 带页码的卡片 | 同上，跳到卡片来源页 |
| 没有页码的卡片 | 切到脑图，通过 `pendingSelection` 交接位把 id 交给工作区，加载完成后选中并居中 |
| 笔记本 | 切到笔记本视图，派发 `pdfnote:open-notebook`，工作区按 id 打开 |

脑图与笔记本都是懒加载，事件可能早于监听——所以「无页码卡片」用了一个模块级交接位
（`pendingSelection.ts`），工作区挂载时主动取走；笔记本则在列表加载完后补开。

## 后端

`global_search(query, limit)` 在命令层一次查三张表：

- `documents.title LIKE ?`，排除 `document_trash`；
- `cards` 的 `question / excerpt / user_note` 任一命中，排除 `card_trash`，且文档已进回收站的卡片也排掉；
- `notebooks.title LIKE ?`。

用户输入先转义 `%`、`_`、`\`（`100%` 按字面量搜）；摘要按**字符**截取并在命中处居中，
避免中文被切坏。每类最多 `limit`（默认 12，上限 40）条。

没上 FTS：本地数据在几千条量级，LIKE + LIMIT 足够快，也避免引入额外索引与迁移。

## 边界

- 只搜标题与卡片正文（问题/摘录/笔记），**不搜标注原文之外的页内文字**；PDF 页内全文搜索用 `⇧⌘F`。
- 不搜标签名、目录节点名与手写本笔迹。
- 卡片正文命中是大小写敏感的 SQLite LIKE（ASCII 不区分大小写，中文不受影响）。
- 结果不排序打分：卡片按 `updated_at` 倒序，文档/笔记本各自倒序，分组顺序固定。

## 验证

```bash
STEP=global-search CARD_COUNT=8 node scripts/mindmap-regression.mjs
STEP=search CARD_COUNT=8 node scripts/mindmap-regression.mjs
```

断言：搜「概念卡片」命中卡片分组；搜「测试教材」回车进文档且面板关闭；
空结果提示；无页码卡片切到脑图并选中 1 个节点；`⌘K` 打开、`Esc` 关闭。
Rust 单测覆盖 LIKE 转义与摘要截取（含省略号与中文边界）。
