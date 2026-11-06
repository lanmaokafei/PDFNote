# 软件更新（0.32.0）

在线检测 GitHub Releases 是否有新安装包，有则提示升级：点「下载升级」显示实时进度，下载完成并校验 SHA-256 后提示点击升级，升级按钮打开 DMG 安装器。

## 用户流程

1. **检测**：启动约 8 秒后后台检查 `https://api.github.com/repos/lanmaokafei/PDFNote/releases/latest`（只认 GitHub Releases 正式版，不含 draft / prerelease）。也可以在「设置 → 软件更新」随时点「检查更新」。
2. **提示**：有新版时弹出升级对话框，显示新旧版本、包体大小与更新说明；已是最新则显示「已是最新版本」。
3. **下载**：点「下载升级」后对话框内出现进度条（百分比 + 已下/总量），下载写入应用数据目录 `updates/`。
4. **校验**：下载完成后自动比对 Release 附带的 `.sha256` 校验文件，不匹配即删除安装包并报错。
5. **升级**：点「立即升级」打开 DMG 安装器，把 `PDFNote.app` 拖进 Applications 覆盖安装，然后重新打开应用即完成升级。

「稍后」会记住该版本号（localStorage `pdfnote.update.dismissedVersion`），同版本不再自动弹窗；设置里的手动检查不受此限制。

## 技术要点

- **全部网络请求在 Rust 侧**（`src-tauri/src/update.rs`，reqwest + rustls）：前端 CSP 保持 `connect-src 'self'` 不放开，浏览器预览模式下功能入口直接报「需要桌面应用」而不是发请求。
- **命令**：`check_for_update`（返回 `UpdateInfo`）、`download_update`（流式下载 + 进度事件 + SHA-256 校验，返回本地 DMG 路径）、`open_update_installer`（`open` 挂载 DMG）、`get_app_version`（设置页展示，不联网）。
- **进度事件**：`update-download-progress`（`DownloadProgress { downloaded, total }`），约 100ms 一次，前端 `listen` 订阅。
- **版本比较**：`X.Y.Z` 数值比较（`v` 前缀可有可无），同版本号时正式版 > 预发布版；GitHub `tag_name` 去掉 `v` 后与 `CARGO_PKG_VERSION` 比较。
- **资产挑选**：优先 `*_aarch64.dmg`（与发布脚本命名一致），校验文件必须是同名加 `.sha256` 后缀；缺 DMG 或缺校验文件的 Release 拒绝下载。
- **下载安全**：先写 `.part` 临时文件，SHA-256 校验通过才改名落盘；校验失败删除半截文件。开始下载前清理 `updates/` 下旧的 `.dmg`/`.sha256`/`.part`，避免堆积。
- **离线保障**：自动检查失败静默返回（网络不可用时完全不打扰）；手动检查把错误原文显示在对话框里并提供「重新检查」。

## 入口

- **自动**：启动 8 秒后后台检查（`App.tsx`），有新版且该版本没被「稍后」过才弹窗。
- **手动**：设置对话框底部「软件更新」区（显示当前版本 + 检查更新按钮）。

## 已知限制

- 「升级」= 打开 DMG 交给 Finder 安装，不做免拖拽的自动替换；ad-hoc 签名未公证，覆盖安装后首次打开仍可能需要右键「打开」。
- GitHub API 匿名限流 60 次/小时/出口 IP；自动检查每次启动最多 1 次，手动检查不限次但建议别连点。
- 只认正式版 Release；预发布（prerelease）与草稿不会提示。
- 下载中断会留下 `.part` 文件被下次下载前清理，不支持断点续传。
- 版本「稍后」记忆只存 localStorage，清缓存或换机器后同版本会再次自动提示。

## 验证

`node scripts/update-smoke.mjs`（需 dev server）覆盖 5 个阶段：

1. 启动自动检测 → 弹出升级提示（版本/包体/更新说明）→「稍后」写入版本记忆；
2. 同版本自动提示不再弹出；
3. 设置手动检查（不受「稍后」限制）→ 下载进度（0 < 进度 < 100）→「下载完成并通过 SHA-256 校验」→「立即升级」调起安装器 →「安装器已打开」；
4. 已是最新 → 明确提示；网络失败 → 错误原文 + 「重新检查」入口；
5. 浏览器（非 Tauri）环境 → 明确报错而不是崩溃。

Rust 单测覆盖版本解析/比较、aarch64 资产挑选、Release JSON 解析、缺资产拒绝、SHA-256 文件解析、非 DMG 拒绝打开。
