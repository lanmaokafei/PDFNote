# 脑图视图 React #185 崩溃复盘

日期：2026-11-02  
版本：0.2.1  
现象：进入「脑图」视图后界面被错误边界接管，显示 “Maximum update depth exceeded”（React error #185），数据未受损。

## 根因

脑图使用 React Flow 的受控节点模式：`nodes` 由 `cardsById` + `positions` 派生，每次渲染都会重新生成数组。
`onSelectionChange` 回调被写成：

```tsx
onSelectionChange={({ nodes }) => setSelectedIds(new Set(nodes.map((n) => n.id)))}
```

即使选择集内容完全相同，`new Set(...)` 也是新引用，于是形成闭环：

1. React Flow 内部节点变化 → `onSelectionChange`
2. `setSelectedIds` 新引用 → MindmapCanvas 重渲染
3. `nodes` 数组重建 → StoreUpdater 执行 `setNodes`
4. 内部节点再次变化 → 回到第 1 步

React 在嵌套更新超过上限后抛出 #185，整棵界面被错误边界替换。

## 修复

- `onSelectionChange` 改为 `useCallback`，并在 `setSelectedIds` 内做内容比较；选择集未变化时返回原引用。
- `onNodesChange` 的位置写入增加 0.01px 容差比较，避免重复写入同坐标。
- 同步 React Flow 的 `dimensions` 变更到 `measuredSizes`，节点携带 `measured`，修复拖拽时 “node is not initialized” 告警。

## 回归验证

用注入 Tauri IPC 模拟的 Chromium 复现（3 张卡片、父子结构）：

| 操作 | 修复前 | 修复后 |
| --- | --- | --- |
| 进入脑图 | #185 崩溃 | 正常渲染 |
| 点击节点 | 崩溃 | 正常选中 |
| 拖拽节点 | 崩溃 | 正常拖动并落盘 |
| PDF 框选建卡 → 脑图 | 崩溃 | 节点出现且可交互 |

同一脚本还覆盖了复习与备份视图，均无 console error / pageerror。

## 回归红线

1. 受控 `nodes` 场景下，任何在 `onSelectionChange` / `onNodesChange` 中调用的 `setState` 都必须做内容比较，禁止无条件创建新数组或新 Set。
2. 不得删除 `measuredSizes` 同步，否则拖拽会退回“节点未初始化”。

---

# 第二次复发：切「大纲」即崩（0.12.1）

日期：2026-11-03  
版本：0.11.0 报障，0.12.1 修复  
现象：打开文档（左 PDF 右脑图）后点击脑图的「大纲」，整屏被错误边界接管。

## 这次是另一条回路

0.2.1 修的是「选择集内容比较」，但**回调仍在 React Flow 的更新阶段同步 setState**。0.11.0 的真实堆栈（用户 crash 日志 + CRASH 现场）：

```
setNodes (xyflow store) → forceStoreRerender → enqueueConcurrentRenderForLane
→ Maximum update depth exceeded
… StoreUpdater → Wrapper → ReactFlow → MindmapCanvas
```

`StoreUpdater` 在 effect 里逐字段比较 props 并 `setNodes`；`nodes` 是我们每次渲染派生的新数组，而 `onSelectionChange` 在其更新阶段又同步 `setSelectedIds`，父组件被再次调度，形成闭环。切到大纲时 React Flow 卸载会触发一次选择重置，恰好把回路点着。

## 复现

`scripts/mindmap-regression.mjs`（mock Tauri IPC + 最小 PDF）：

```bash
npm run dev -- --host 127.0.0.1
CARD_COUNT=120 STEP=outline node scripts/mindmap-regression.mjs
```

- `STEP=outline`：点「大纲」→ 复现 #185（修复前）。
- `STEP=collapse`：只折叠/展开，不复现。
- `STEP=all`：折叠 + 大纲往返 + 拖拽 + resize + 选择断言。

## 修复

1. **选择改由 `select` change 驱动**：受控 `nodes` 模式下 React Flow 不会自己改选中态，必须由父组件应用 `{type:'select'}`；原来的 `onSelectionChange` 是纯观察回调，去掉。
2. **`setSelectedIds` 离开同步阶段**：选择变更合并到下一帧（`requestAnimationFrame`），并按集合内容比较；同一帧多次变更只渲染一次。
3. **`handleNodesChange` 不在拖拽中回写位置**（`change.dragging` 跳过），松手后由 `onNodeDragStop` 一次性落盘。
4. **测量回写收紧**：忽略 ≤2px 的尺寸、只接受超过 24px 的明显变化，并加 60 次/秒熔断——即使再出现未知抖动也会断链，而不是升级为 #185。
5. **传给 React Flow 的对象/数组常量化**：`fitViewOptions`、`panOnDrag`、`multiSelectionKeyCode`、`defaultViewport` 提为模块常量，避免 StoreUpdater 每次渲染都写 store。
6. **节点 data 与卡片列表同生命周期**：`nodeData` 用 `useMemo` 按 id 建映射，位置变化重建 nodes 时复用同一 data 引用。

## 回归红线（更新）

1. 受控 `nodes` 下，任何 `setState` 都必须在事件/微任务/下一帧里执行，禁止在 React Flow 的订阅回调中同步更新父组件。
2. 选择必须由 `select` change 应用，**不要**再用 `onSelectionChange` 驱动状态。
3. 传给 React Flow 的对象/数组 prop 必须引用稳定（模块常量或 `useMemo`）。
4. `measuredSizes` 仍要回写（否则拖拽提示节点未初始化），但必须带容差 + 熔断。
5. 任何脑图改动都要跑 `scripts/mindmap-regression.mjs`（`STEP=all`、至少 120 节点）。

## 结果

| 场景（120 节点） | 修复前 | 修复后 |
| --- | --- | --- |
| 切到大纲 | #185 崩溃 | 正常，可往返 |
| 折叠/展开 | 正常 | 正常 |
| 拖拽节点 | 正常 | 正常，位置落盘 |
| 连续 resize | 正常 | 正常 |
| 单选 / Meta 多选 | 正常 | 正常（`is-selected` 正确） |
