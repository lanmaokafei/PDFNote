# 画布涂鸦与脑图分层（0.38.0）

> 复用 v10 的通用 `layers` 表，给脑图画布补上「直接手写」与「按层显隐卡片」。
> 墨迹点用 React Flow **世界坐标**，平移缩放时跟节点一起移动，不做屏幕坐标快照。

## 入口

脑图工具条的「涂鸦」「图层」两个按钮（嵌入视图也有）。

- **涂鸦**：点开进入画笔模式，画布上方出现取色点、笔宽 / 橡皮半径滑杆（与 PDF 墨迹、笔记本共用 `SizeControl`）。
  再点一次退出；落笔时临时关闭节点拖拽、连线与画布平移，避免和手势打架。
- **图层**：右侧浮出图层面板。每张画布至少一个图层，第一次打开自动建「主层」。

## 世界坐标墨迹

- `ViewportPortal` 把 SVG 挂进 `.react-flow__viewport`，路径点直接写世界坐标，平移缩放由 React Flow 统一变换。
- 落笔时 `screenToFlowPosition(clientX, clientY)` 把屏幕坐标换成世界坐标；一笔一行，抬笔时写入 `canvas_inks`。
- 笔宽沿用归一化值（×1000 变成 flow 单位），所以 PDF、笔记本、画布三处的滑杆数值含义一致。
- 橡皮命中复用 `findInkHits`：半径滑杆值先除以当前 `zoom` 换算成世界单位，隐藏 / 锁定的图层不参与命中；按住可连擦，松手串行删除。
- 回归里会先平移画布，再断言同一条笔迹的屏幕包围盒跟着移动——这是「世界坐标」而不是「贴在屏幕上」的硬证据。

## 脑图分层

- `mindmap_layer_members(layer_id, card_id, canvas_id)` 记录卡片属于哪个画布图层；**没有行的卡片属于「未分层」，永远可见**。
- 图层面板里可以：新建、双击改名、眼睛切显隐、锁切可写、删除（连带墨迹与卡片归属需二次确认）、点选当前落笔层。
- 「把选中卡片归入当前层」把当前 React Flow 选中的节点写入该层；「移出分层」把它们还原为未分层。
- **隐藏一个图层会同时隐藏该层的墨迹与卡片**：`cards` 派生数组直接过滤掉隐藏层的成员，所以节点、连线、大纲、回忆都一起少掉，不需要三份内容再同步。
- 卡片在同一画布上最多属于一个图层；跨画布归属互不干扰。

## 数据模型（schema v11）

```sql
canvas_inks(id, canvas_id, layer_id, points_json, style_json, created_at, updated_at)
mindmap_layer_members(layer_id, card_id, canvas_id, PRIMARY KEY(layer_id, card_id))
```

- 两张表都外键到 `layers(id)` 并 `ON DELETE CASCADE`：删层即删该层墨迹与卡片归属。
- `canvas_inks.canvas_id` 外键到 `mindmap_canvases(id)`；`points_json` 是 `[[x,y],…]` 世界坐标数组。
- **不改 `mindmap_layout`、不改 `cards`**：备份覆盖导入的 `INSERT INTO mindmap_layout SELECT *` 不需要版本分支，这是把归属拆成关联表的主要原因。
- 备份：两表加入 overwrite 的 DELETE 列表（先子后父）与 `copy_table_if_present`；merge 按 id / 复合主键去重，并要求画布、卡片、图层都存在。旧备份（< v11）没有这两张表时 `import_has_table` 直接跳过。

## 性能

- 墨迹一次最多读 20000 笔；SVG 只有 1px 画布 + `overflow:visible`，不会创建巨型 DOM 容器。
- 隐藏图层的笔迹与卡片在这一层就被过滤掉，不进 React Flow 的 `nodes` 计算，1483 卡大画布规则不变。
- 落笔期间才挂一层 pointer 捕获 `div`；不落笔时完全不渲染，节点交互零开销。

## 已知边界

- 图层不能跨画布共享，也不能把一张卡片同时放进两个图层。
- 不支持图层排序、图层混合模式、按层导出、把笔迹转成卡片。
- 涂鸦只在画布视图可用，大纲视图不显示笔迹。
- 没有撤销 / 重做；橡皮仍是整笔删除，不做局部擦除。
- 隐藏图层会把卡片从 `cards` 派生数组里移除，因此该层卡片暂时也不会出现在大纲、复习与回忆里（这是「隐藏」的本意，不是数据删除）。

## 验证

```bash
npm run dev -- --host 127.0.0.1
STEP=canvas-ink CARD_COUNT=3 SHOT=1 node scripts/mindmap-regression.mjs
```

覆盖：进入涂鸦画第一笔（落库 1 条、SVG 1 条 path）→ 退出后平移，断言笔迹包围盒随视口移动 → 新建图层画第二笔（写进新层）→ 隐藏该层只剩 1 笔 → 把选中卡片归入隐藏层后节点消失 → 恢复显示笔迹与卡片一起回来 → 橡皮半径滑杆拖到 56px 擦掉第一笔（剩 1 笔）。

Rust 单测（`canvas_layers::tests`，3 项）：墨迹往返与非法点 / 跨画布图层拒绝、卡片在层间移动与移出分层、删层级联清掉墨迹与归属。
