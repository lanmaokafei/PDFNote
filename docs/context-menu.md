# 应用内右键菜单（0.10.0）

## 背景

Tauri v2 在 macOS 使用 WKWebView，默认右键菜单通常只有 Reload，选中文字、标注、卡片后无法就地操作。0.10.0 由应用接管右键：全局抑制原生菜单，按右键命中的元素给出上下文相关操作。

- 全局拦截在 `document` 的 capture 阶段执行（`installNativeContextMenuGuard()`），确保早于任何组件逻辑；`input` / `textarea` / `select` / `contenteditable` 放行，保留系统自带的复制粘贴与拼写菜单。
- 菜单通过 `createPortal` 渲染到 `document.body`，不受 `.pdf-scroll`、`overflow: hidden` 等容器裁剪。

## 组件分层

| 文件 | 职责 |
| --- | --- |
| `src/ui/contextMenuCore.ts` | 菜单类型、`useContextMenu()`（打开/关闭状态）、元素是否可编辑的判定、原生菜单接管 |
| `src/ui/ContextMenu.tsx` / `.css` | 菜单渲染：分组标题、图标、危险项、勾选态、快捷键提示；边界翻转、键盘导航、ESC / 外部点击 / 滚动关闭 |
| `src/ui/contextMenuPosition.ts` | 纯定位函数（右下角空间不足时翻转，再 clamp 到视口），有独立单测 |
| `src/features/pdf/textSelection.ts` | `readTextSelection()`：右键时重新读取该页文字层的原生 DOM 选区与归一化 bbox |

同一时刻只允许一个菜单打开：分栏工作区里 PDF 与脑图各自持有菜单实例，模块级 `activeClose` 在新菜单出现时先关掉旧菜单。

## 菜单矩阵

| 位置 | 命中元素 | 主要动作 |
| --- | --- | --- |
| PDF | 选中的文字 | 复制文字、复制为引用（带页码）、用选中文字建卡、取消选择、切换文字模式 |
| PDF | 高亮 / 矩形标注 | 复制摘录、在检查器查看、编辑标签、关联卡片、合并卡片、删除标注 |
| PDF | 墨迹笔画 | 删除这条墨迹、切换墨迹工具 |
| PDF | 回忆遮挡块 | 揭示此处摘录、退出文档回忆 |
| PDF | 页面空白 | 五种标注工具（含当前项勾选）、放大/缩小/恢复 100%、上下翻页、复制本页文字、开始/退出回忆 |
| 脑图 | 节点 / 大纲行 | 编辑、复制标题、折叠展开、标签、链接、合并所选、移出脑图、彻底删除、切换视图、导出 MD |
| 脑图 | 画布 / 大纲空白 | 新建卡片、刷新、自动整理、保存布局、切换视图、导出 MD、主动回忆 |
| 资料库 | 文档卡片 | 打开、复制标题、重新定位 PDF、刷新、导入新 PDF、移除文档 |
| 复习 | 当前卡片 | 显示/隐藏答案、编辑、复制问题/摘录/选中文字、重新检查队列 |
| 全局 | 其它空白区域 | 复制选中文字、资料库 / 脑图 / 复习 / 备份快捷导航 |

## 实现约定

- **动作复用**：工具切换、缩放、翻页、标签/链接/合并对话框、删除确认等通过 `PdfContextAction` 上抛到 `PdfWorkspace`，复用已有命令，不新增后端接口；复制走 `navigator.clipboard`。
- **选区即时读取**：右键时不依赖浮动操作条的 `selection` state，而是 `readTextSelection()` 重新读 DOM 选区；跨页选区因公共祖先不在本页文字层内而被忽略。
- **select 工具下也能建卡**：`handleCreate` 原先以 `tool === 'select'` 作为防御性拦截，会误拒右键建卡。现改为由调用方显式传 `annotationKind`（文字选区默认高亮），框选路径仍按当前工具决定标注类型。
- **输入框例外**：`useContextMenu.show()` 会跳过可编辑目标，避免系统菜单与应用菜单同时出现。
- 键盘：`↑` / `↓` 跳过禁用项，`Enter` 执行，`Esc` 关闭；菜单滚动不会触发关闭。

## 验证

- `src/ui/contextMenuPosition.test.ts`：6 项定位边界用例。
- `scripts/contextmenu-smoke.mjs`（需 `npm run dev`）：无头 Chrome 验证原生菜单被接管、菜单项齐全、ESC / 外部点击关闭、右下角翻转、输入框保留系统菜单、菜单项真实切换工作区、方向键高亮，以及 `readTextSelection()` 的选区与跨层判定。
