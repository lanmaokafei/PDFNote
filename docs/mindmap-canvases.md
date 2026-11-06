# 多画布脑图与 AnkiDroid 导入（0.20.0）

## 要解决的问题

0.19.0 及更早只有一张写死为 `main` 的脑图：同一本书的不同复习思路（按章节、按题型、按错题）只能混在一起，清空或整理都会影响全部卡片。同时，很多人的题库已经在 AnkiDroid 里，重新手工建卡成本很高。

0.20.0 同时补上这两块：

- **多画布**：一本书可以有多张脑图，也可以有不绑定任何书的全局脑图。
- **AnkiDroid txt 导入**：把牌组层级变成脑图分组节点，把正面 / 背面变成问题卡与摘录。

## 数据模型

schema 从 v8 升到 v9，只新增一张表：

```sql
CREATE TABLE mindmap_canvases (
    id          TEXT PRIMARY KEY,
    document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
```

归属关系**不新增字段**，直接复用 `mindmap_layout` 原有的复合主键 `(canvas_id, card_id)`：

- 某张卡在画布 `X` 里有一行 `mindmap_layout`，就表示它出现在画布 `X`；
- 同一张卡可以出现在多张画布上，每张画布各有自己的 `(x, y)`；
- `cards.surface_mindmap` 退化为派生开关：只要任意画布还有它的布局就是 1，全部布局被删掉才是 0（`canvases::sync_mindmap_surface` 维护）。

`document_id` 用 `ON DELETE SET NULL`：删书后画布自动变全局画布，卡片与坐标都不丢。`main` 是系统保留的全局默认画布，不能删除。

迁移 `009_mindmap_canvases.sql` 做三件兼容工作：

1. 补登记 `main`；
2. 把旧备份里出现过的其他 `canvas_id` 一起登记，避免「布局还在、画布消失」；
3. 给「`surface_mindmap = 1` 但完全没有布局行」的历史卡片补一行 `main` 布局，坐标由前端树形布局重新生成。

## 命令

| 命令 | 说明 |
| --- | --- |
| `list_mindmap_canvases(documentId)` | `Some(d)` → 全局画布 + 该书画布；`None` → 全部 |
| `create_mindmap_canvas(input)` | `id` 可省略（后端生成 UUID）；`document_id: null` 即全局画布 |
| `rename_mindmap_canvas(id, name)` | 1–60 字符 |
| `delete_mindmap_canvas(id)` | 只删该画布的布局行，卡片内容保留；`main` 拒绝删除 |
| `remove_card_from_mindmap(id, canvasId)` | 只退出指定画布；仍在其他画布时不改父子结构、不改 `surface_mindmap` |
| `clear_mindmap_cards(mode, canvasId)` | `remove` 只清该画布布局；`delete` 删该画布上的卡片本体（级联所有画布布局） |
| `create_card(input.canvas_id)` | 新卡写入指定画布，缺省 `main` |
| `apply_book_outline(..., canvasId)` | AI 拆书骨架写入指定画布；已有卡片复用内容，只补布局 |
| `preview_anki_txt(sourcePath)` | 只解析不写库 |
| `import_anki_txt(input)` | 单事务按勾选牌组建树 |

所有跨表写入都在显式事务里，最后统一调用 `sync_mindmap_surface`。

## 前端行为

- 选择偏好按文档分别记住：`pdfnote.mindmap.canvas.<documentId>`，独立脑图视图用全局 key。
- 文档工作台看到「全局画布 + 本书画布」，独立脑图看到全部画布；新建时默认勾选「绑定到当前这本书」，可取消改全局。
- 卡片列表 = `surface_mindmap` 的卡片与当前画布 `mindmap_layout` 成员的交集。自动整理、拖拽落盘、清空、新建卡片、移除卡片、AI 拆书、Anki 导入全部带 `canvasId`。
- **画布常驻红线不受影响**：切换画布时旧成员会短暂保留并盖一层「正在切换画布…」，React Flow 不会被卸载重建；`layoutScope !== canvasId` 时禁止任何布局补写，避免把旧画布卡片串进新画布。
- PDF 划重点建卡会写入当前选中的画布（不再是永远 `main`），并通过 `pdfnote:mindmap-changed` 通知右侧脑图刷新。AI 拆书与 Anki 导入也会发同样的通知。
- 嵌入分栏较窄，画布工具坞占第一行，原有操作按钮、回忆状态依次下移，避免互相遮挡点击。

## AnkiDroid txt 解析

支持两种实测格式：

1. **标准导出**：`#separator:tab`、`#html:true`、`#guid/#notetype/#deck/#tags column:N` 元数据 + 6 列 `guid / notetype / deck / Front / Back / tags`；
2. **仅正面导出**：没有列号元数据，正面用引号包裹且可跨行，背面为空。

解析细节：

- 列号是 1-based，非法值忽略；问题 / 答案列自动取「除元数据列之外」的前两列；
- 引号内的 tab / 换行属于字段内容，`""` 表示一个字面引号；
- `#html:true` 时把 `br / p / div / li / tr / hr` 转成换行，剥离内联标签（含 `<span style=...>`），解码 `&nbsp;` / `&amp;` / `&lt;` 等实体；
- 牌组用 `::` 表示层级，末级名称会补成标签；tags 按空格切分，最多 6 个；
- 无牌组列时归入「未分组」；
- 单文件上限 24 MB，非 UTF-8 明确报错。

导入时按牌组层级创建分组节点（`surface_review = 0`），问题作为 `question`、答案作为 `excerpt` 写入复习卡（`surface_review = 1`）。**去重按整张画布的问题文本**，不按分组：两份参考导出其实是同一套卡的两种格式，先导入「仅正面」再导入「含答案」时，后一份只会把答案与标签补齐，不会复制出第二套树或留下一堆空分组。

导入完成后前端刷新成员、按树形布局自动整理并 `fitView`。

## 备份兼容

`mindmap_canvases` 已加入 overwrite 的 DELETE 列表、merge 的复制表清单，以及 `copy_table_if_present`。merge 时 `document_id` 按 `content_hash` 重映射到本地文档，找不到对应文档就退化为全局画布。`ensure_layout_canvases` 会在导入旧备份后补回 `main` 与所有未登记的 `canvas_id`，保证画布和布局始终对得上。

## 验证

- Rust：`cargo test --lib`（77 passed / 2 ignored），覆盖画布 CRUD、按画布移除 / 清空、拆书写第二画布、标准 / 仅正面解析、HTML 清洗、建树、幂等导入、牌组筛选、跨格式答案补齐与真实文件可选测试。
- 真实文件校验：设置 `ANKI_FIXTURE_PATH` 指向 AnkiDroid 导出的 txt 后运行 `cargo test --lib parses_real_export_when_fixture_is_provided -- --nocapture`。项目里两份参考导出分别解析出 1455 张卡（26 个牌组 / 仅正面 1 个「未分组」）。参考文件体积大且含用户数据，已加入 `.gitignore`，不入库。
- 端到端：`STEP=canvas`（隔离、切换不卸载 React Flow、新建 / 重命名 / 删除与回落）、`STEP=anki`（预览、牌组勾选、导入目标画布、默认画布不受污染）。
- 另需跑 `STEP=all CARD_COUNT=120` 与既有 `STEP=*` 场景，确认 0.19.0 及以前的行为没有回退。

## 已知限制

- 画布之间不共享卡片内容副本：同一张卡出现在两张画布时，编辑内容会同时反映到两处（本来就是同一张 Card），但布局各自独立。
- 一次导入上千张卡会让 React Flow 一次性渲染全部节点；超大题库建议按牌组分批导入。
- 仅正面导出没有牌组信息，全部归入「未分组」；需要层级时请用带 `#deck column` 的标准导出。
- Anki 的图片 / 音频媒体文件不在 txt 里，暂不导入；HTML 只做文本清洗，不保留样式。

## 每本书自带画布与自动关联（0.25.0）

0.24 及以前：新导入的 PDF 没有专属画布，打开时回落到全局 `main`。而 `main` 往往留着上一本书的 AI 拆书内容，于是「打开新 PDF 却看到别人的脑图」。

0.25.0 起：

1. **导入即建画布**：`import_document` 在同一个事务里插入 `mindmap_canvases`，`document_id` 指向新文档，名字用文档标题（截断 60 字）。去重导入（同一 SHA-256）直接返回已有文档，不会重复建画布。
2. **打开时按优先级选画布**：
   - 用户在 localStorage 里选过的画布（`pdfnote.mindmap.canvas.<docId>`）优先 —— 下次打开自动关联同一张；
   - 否则选这本书**最新**的专属画布（`updated_at` 最近）；
   - 这本书一张专属画布都没有（升级前导入的老文档）→ 自动补建一张并选中，名字取文档标题；
   - 都没有才回落全局 `main`。
3. **手动选择会记住**：下拉里切到任意画布（包括全局画布）都会写偏好，下次打开原样恢复。
4. **加载时序**：画布归属解析完成前不请求卡片成员，避免先用 `main` 拉一遍、短暂闪出全局画布内容。

### 注意

- 升级后第一次打开旧文档会多出一张以书名为名的空画布（这是预期行为）；想继续用全局画布，在下拉里切回「默认画布」即可，之后会记住。
- 删掉某本书唯一的专属画布后，下次打开会再补一张空画布。
- 一本书可以有多张画布（例如「教材」「错题」），偏好按书记住，互不影响。

### 回归

```bash
# 没有专属画布 → 自动补建并选中，重开文档复用同一张
EMPTY_DOC_CANVAS=1 STEP=doc-canvas CARD_COUNT=3 node scripts/mindmap-regression.mjs

# 没有偏好 → 打开本书最新的画布
CANVAS_PREF=none STEP=canvas CARD_COUNT=3 node scripts/mindmap-regression.mjs
```
