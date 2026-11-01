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
