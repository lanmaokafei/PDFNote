# 公式渲染（0.13.0）

卡片摘录里保存的是 LaTeX **源码**，阅读时需要排版成人类可读的公式。0.13.0 起用
[KaTeX](https://katex.org/) 在本地渲染，不联网、不上传任何内容。

## 为什么是 KaTeX

| 方案 | 离线 | 体积 | 说明 |
| --- | --- | --- | --- |
| **KaTeX（选用）** | 是 | 约 2.6 MB（含 19 个 woff2 字体） | 同步渲染、无 iframe、可随卡片一起滚动 |
| MathJax | 是 | 更大（约 6 MB+） | 适合复杂宏包，本场景用不到 |
| 图片 / 远程服务 | 否 | — | 与「完全离线」定位冲突 |

字体走 Vite 的 assets，打包进 `.app`，因此断网也能正常排版。

## 识别规则

`src/ui/latex.ts` 决定一段文字怎么渲染：

1. **显式定界符**：`$...$`、`$$...$$`、`\(...\)`、`\[...\]` 按出现位置切分，
   定界符外的文字保持原样（换行保留）。未闭合的定界符按普通文本处理，
   避免把「价格 $5 元」这类内容吞成公式。
2. **裸 LaTeX**：AI 识别返回的常常不带 `$`，例如
   `H = -\sum_{i=1}^{n} P(x_i) \log_2 P(x_i)`。满足以下条件时整段按块级公式渲染：
   - 含 LaTeX 命令（`\sum`、`\frac`、`\log`…）且中文不超过 2 个（允许 `\text{中文}`）；
   - 或含 `^` / `_` 上下标且含字母、无中文；
   - 或运算符（`=`、`+`、`∫`、`∑`…）≥ 2 且含字母数字、无中文。
3. 超过 500 字的文本一律按纯文本处理，避免长笔记被误判。

## 渲染位置

| 位置 | 组件 |
| --- | --- |
| 脑图卡片（摘录 / 笔记） | `MindmapNode` |
| 脑图大纲行 | `MindmapWorkspace` |
| 复习卡背面（摘录 / 笔记） | `ReviewWorkspace` |

编辑态（`textarea`）始终显示原始 LaTeX 源码，方便修改；只读展示才渲染。

## 截图与渲染结果的取舍

公式卡片会同时带一张选区截图（`excerpt_image`）和渲染后的 LaTeX。两者内容重复，
而且截图会占掉卡片高度、把公式挤到可视区域之外。规则：

- 摘录**能**渲染成公式（`hasMathContent` 为真）→ 不显示截图，只显示排版后的公式；
- 摘录为空、只有截图（OCR 没识别出文字）→ 仍然显示截图；
- 普通文字摘录带截图 → 两者都显示（图片是补充证据）。

PDF 端的原标注与截图始终保留，卡片仍可从来源回跳，所以隐藏的只是脑图里的重复展示。

## 实现要点

- `src/ui/MathText.tsx`：`katex.renderToString` + `dangerouslySetInnerHTML`；
  文本段逐个 HTML 转义，KaTeX 自身负责公式转义。
- `throwOnError: false` + `strict: false`：非法宏显示成红字，不抛异常、不影响卡片其他内容。
- 渲染结果按文本做 400 条内存缓存：同一公式在脑图、大纲、复习里反复出现时只排版一次。
- 块级公式容器允许横向滚动（`.katex-display { overflow-x: auto }`），长公式不会撑破窄节点。

## 脑图画布导航（同一版本修正）

旧配置下左键在空白处是**框选**，鼠标滚轮是**缩放**，所以「拖画布没反应、滚轮不移动」。
0.13.0 调整为白板类应用的习惯：

| 操作 | 行为 |
| --- | --- |
| 左键拖动空白 | 平移画布（`panOnDrag = [0,1,2]`，中键/右键同样平移） |
| 触控板双指滑动 / 滚轮 | 平移（`panOnScroll`，`zoomOnScroll=false`） |
| `⌘` + 滚轮 / 双指捏合 | 缩放（`zoomActivationKeyCode="Meta"`） |
| `Shift` + 拖拽 | 框选（`selectionKeyCode="Shift"`） |
| 左下角控件 | 放大 / 缩小 / 适配视图 |

画布左上角有一行常驻提示说明这些操作（紧凑的嵌入模式不显示，避免占地方）。

## 验证

```bash
npm run dev -- --host 127.0.0.1
STEP=math CARD_COUNT=9 node scripts/mindmap-regression.mjs   # 公式渲染 + 字体加载
STEP=pan  CARD_COUNT=9 node scripts/mindmap-regression.mjs   # 左键平移 + 滚轮平移
npx vitest run src/ui/latex.test.ts                          # 9 项检测/切分用例
```

`STEP=math` 会检查 `.mindmap-node .katex` 与 `.katex-display` 存在，并用
`document.fonts.check('16px KaTeX_Main')` 确认字体真的加载（缺字体会显示成方框）。
