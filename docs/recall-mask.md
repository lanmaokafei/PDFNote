# 回忆态遮住脑图分栏（0.67.0）

文档回忆开始时，右侧并排的脑图会整栏遮住——卡片标题、摘录就摆在那里，不遮等于把答案摊开。

## 行为

- 进入文档回忆（工具坞「遮挡回忆」/⌘⇧M 那类入口）→ 右栏立即出现遮罩：
  「文档回忆中 · 脑图已遮住，避免直接看到卡片答案」+ **退出回忆** 按钮。
- 退出回忆的方式两种都行：工具坞再点一次，或直接点遮罩上的「退出回忆」。
- 遮罩期间脑图是 `visibility: hidden`，**不卸载**——卸载会丢 React Flow 的 viewport 与 measured，
  回来就得重新布局；隐藏既保住状态，也不会让答案被选中/复制/读屏。
- 遮罩退出后手写墨迹、留白与脑图同时恢复。

## 实现

- `PdfWorkspace` 新增 `onRecallChange(active)`：回忆开关变化时通知外层。
- `StudyWorkspace` 用 `recallActive` 给右栏加 `is-recall-masked`，渲染遮罩；遮罩按钮派发
  `pdfnote:stop-recall`，由 `PdfWorkspace` 的监听统一收尾（清 session、清选中、关掉回忆）。
- 用事件而不是传回调，避免把状态穿透到遮罩组件，也方便以后在其它入口触发退出。
- 粗读精读工作区复用同一个 `StudyWorkspace`，自动获得同样行为。

## 边界

- 只遮**并排的脑图分栏**；PDF 页面本身的遮挡逻辑不变。
- 脑图栏被遮住时不能拖动分栏比例（遮罩盖住了分隔条右侧的点击区），退出回忆后恢复。
- 若把脑图分栏关掉（纯 PDF 模式），不需要也没有遮罩。

## 验证

```bash
STEP=recall RECALL_SEED=1 node scripts/mindmap-regression.mjs
```

断言：进入回忆后遮罩出现、`.mindmap-workspace` 计算样式为 `hidden`、手写与留白都隐藏；
退出回忆后遮罩消失；再从遮罩上的「退出回忆」按钮退出，脑图恢复 `visible`、手写恢复 1 条。
