# 526MB / 752 页教材假死问题复盘

日期：2026-11-02  
复现文件：`信息系统项目管理师教程-第四版.pdf`（525,808,729 bytes，752 页，A4）

## 现象

导入该 PDF 后应用假死，CPU 长时间接近 100%，随后退出或被迫关闭。数据库显示文档导入成功、页数 752，但没有任何卡片。

## 根因

这是三个问题叠加，不是单一 PDF 解析失败。

### 1. 自动备份重复压缩已压缩的 PDF

导入完成后立即触发自动备份。旧实现对所有文件使用 deflate level 6，包括 526MB PDF。该 PDF 本身已是压缩格式，备份耗时约 110 秒，生成 456MB ZIP；同步命令又占用主线程，导致窗口无响应。

修复：

- 所有文件构建、哈希、导入、恢复命令改为 `#[tauri::command(async)]`，在 Tauri 线程池运行。
- PDF 在 ZIP 中使用 Stored 模式，只有 SQLite 快照使用 deflate。
- 自动备份延迟到启动后 60 秒与每 30 分钟检查；数据未变化时直接复用最近备份。
- 以备份文件名中的开始时间判断新鲜度，避免备份期间的修改被误判为已备份。

### 2. PDF 视图高度链未约束，页级虚拟化完全失效

`.app-main`、`.app-immersive`、`.app-pdf-canvas` 都没有确定高度，`.pdf-scroll` 被 752 页内容撑到 **619,716px**；滚动容器自身高度等于内容高度，IntersectionObserver 认为 752 页全部可见，于是对每一页调用 `pdf.getPage()`。

修复：

```css
.app-shell.is-immersive .app-main { height: 100vh; min-height: 0; overflow: hidden; }
.app-immersive { height: 100%; min-height: 0; overflow: hidden; }
.app-pdf-canvas { flex: 1; min-height: 0; height: auto; overflow: hidden; }
```

观察器改为以窗口视口为根，`rootMargin: 100% 0px`。修复后实测：

- 滚动容器高度：664px（此前 619,716px）
- 752 个占位页中 `intersect=1`
- 首屏仅 `getPage(1)`，没有遍历全部页

### 3. Tauri asset 协议导致 PDF.js 整本拉取

PDF.js 首次请求不带 `Range`。Tauri asset 协议只在收到 Range 请求后才在 206 响应中声明 `Accept-Ranges`；PDF.js 因此判断不支持分块，退回 200 全量读取 526MB。

修复：

- 新增 Rust `read_pdf_chunk(document_id, begin, end)`，只允许读取应用数据目录内的 PDF，单块上限 8MB。
- 前端使用 `PDFDataRangeTransport`，每块 256KB，可按需读取。
- PDF 页代理缓存限制为最近 16 页，淘汰时调用 `page.cleanup()`。
- 超过 200MB 的文档显示“按需读取大型 PDF”状态。

## 验证

同一份教材独立压测（Chromium + 自定义 Range）：

| 指标 | 结果 |
| --- | --- |
| 元数据加载 | 140ms |
| 实际网络读取 | 14 个 Range 请求，约 4.2MB（此前 501.5MB 整本） |
| 渲染第 1 / 376 / 752 页 | 84ms / 113ms / 50ms |
| JS 堆 | 约 10.6MB |
| 原生诊断版运行 30 秒 | 进程存活，首屏仅请求第 1 页 |

## 回归红线

1. 不得移除沉浸视图的高度约束；否则 PDF 虚拟化会再次失效。
2. 不得移除 `disableStream` / `disableAutoFetch` / `PDFDataRangeTransport` 的组合。
3. 不得对 PDF 恢复 deflate 压缩；大教材备份会重新阻塞。
4. 大文件相关重任务必须保持 async command，不得回到 WebView 主线程。

## 后续修复：顶端导航栏随滚动移走

现象：打开 PDF 后滚动页面，应用顶部栏与 PDF 工具栏一起离开视口。

原因：应用外层仍使用页面级滚动，`.app-shell` / `#root` 只是设置 `min-height`，内容增长时 `body` 可以滚动；PDF 内部虚拟化滚动并未成为唯一的滚动源。

修复：

```css
html, body, #root { height: 100%; }
body { overflow: hidden; overscroll-behavior: none; }
.app-shell { height: 100vh; overflow: hidden; }
.app-main { height: 100%; min-height: 0; overflow: hidden; }
.app-view { flex: 1; min-height: 0; overflow-y: auto; }
```

PDF 沉浸视图的高度链继续保持 `100% → flex → pdf-scroll`，滚动只发生在 `.pdf-scroll`。已验证：

- `body` clientHeight = scrollHeight = 800px，窗口滚动量始终为 0。
- 资料库内容滚动发生在 `.app-view` 内（78px）。
- `.app-topbar` 在滚动前后 top 均为 `0`。
- 移动端使用 `100dvh`，沉浸模式隐藏底部导航。
