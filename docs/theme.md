# 深色模式（0.63.0）

顶栏新增 **月亮 / 太阳** 按钮一键切换；设置 → 外观还可以选 **跟随系统 / 浅色 / 深色**。

## 实现

- 主题写在 `<html data-theme="light|dark">` 上，所有深色规则挂在属性选择器下；
  切换不改任何组件状态，也不重渲染画布。
- 首帧前在 `main.tsx` 里应用主题（`applyTheme(readThemeMode())`），避免深色用户先看到白屏闪烁。
- 模式存 `localStorage` 的 `pdfnote.theme`；`system` 会监听 `prefers-color-scheme` 变化。
- 多个组件各自持有一份主题 hook，写盘后广播 `pdfnote:theme-changed`，顶栏与设置面板保持同步。

## 主题化范围

**只改界面外壳**：

- 顶栏、各工作区背景、卡片盒、复习页、资料库面板、弹窗、输入框、工具栏、缩略图侧栏；
- 脑图画布与节点卡（节点改成深色卡面，配色角标与色调仍保留）；
- PDF 页面周围的滚动底色、底部工具坞、浮动工具条；
- 手写本的书架与工具栏。

**保持不变**：

- PDF 纸面、手写本纸面仍是白纸——阅读面不做反色；
- 卡片主题（极简 / 淡彩 / 墨色）的色调仍按用户选择走，深色模式下只把卡面压成深底；
- 导出图片、年度海报、分享图不受主题影响（Canvas 里固定配色）。

## 优先级上的一个坑

组件样式里大量使用 `.mindmap-workspace[data-mm-theme="tint"] .mindmap-node` 这类三段选择器，
权重高于 `[data-theme="dark"] .mindmap-node`。深色规则统一加 `html` 前缀提高一级权重，
并对脑图这类主题化组件再按 `.mindmap-workspace .mindmap-node` 压一层，否则卡片仍是浅色。

## 边界

- 深色模式是**按区块覆盖**，不是逐像素重绘：个别次要面板可能仍是浅色（欢迎补截图）。
- PDF 页面选中文字、标注高亮的颜色按原有配色，不随主题变。
- 打印 / 导出走 Canvas 固定配色，深色模式不会把导出图变黑。

## 验证

```bash
STEP=theme CARD_COUNT=3 node scripts/mindmap-regression.mjs
STEP=dark-shots CARD_COUNT=8 BOARD=1 node scripts/mindmap-regression.mjs
```

`STEP=theme` 断言：默认浅色 → 点按钮变深色且写入偏好 → 外壳背景 `rgb(14,19,16)`、正文变浅 →
刷新后仍深色 → 切回浅色并写回偏好。
`STEP=dark-shots` 逐视图截图（资料库 / 卡片盒 / 复习 / 笔记本 / 文档 / 脑图 / 设置），用于人工目检。
