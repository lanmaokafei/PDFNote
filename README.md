# PDFNote

本地优先、卡片轴心的 PDF 学习应用。技术栈为 Tauri v2 + React + TypeScript + SQLite；无后端、无登录，目标为完全离线运行。

## 当前进度

阶段 1（数据模型与工程骨架）已落地：

- Card / documents / annotations / mindmap_layout / review_logs schema v1。
- Rust 统一 SQLite 边界，建卡、脑图移除、删除卡片命令。
- Zustand 规范化 `cardsById`，三视图共享同一 Card 类型和内存数据源。
- Tauri 最小权限、WAL、外键、应用数据目录初始化。
- React 基础工作台与数据库自检。

详细决策见 [架构基线](docs/architecture.md)，排期和验收见 [实施计划](docs/implementation-plan.md)。

## 运行前端

```bash
npm install
npm run dev
```

浏览器打开 `http://localhost:1420`。纯浏览器模式仅用于 UI 预览，数据库自检会显示“浏览器预览”，不会创建本地数据库。

## 运行桌面应用

先安装 Rust（stable）及对应平台的 Tauri 系统依赖，然后：

```bash
npm run tauri dev
```

原生验证命令：

```bash
cargo test --manifest-path src-tauri/Cargo.toml
npm run build
npm run lint
```

## 验证与构建

```bash
npm run build       # TypeScript + Vite 生产构建
npm run lint        # Oxlint
npm run tauri build # 生成平台安装包，需要 Rust 工具链
```

## 关键目录

```text
src/domain/             前端共享领域类型
src/services/           类型化 Tauri invoke 边界
src/store/              单一 Card 内存 store
src-tauri/src/          Rust commands / models / db
src-tauri/migrations/   SQLite 顺序迁移
src-tauri/capabilities/ 主窗口最小权限
public/pdfjs/           后续 PDF.js 离线 worker / fonts / cmaps
docs/                   架构与实施验收文档
```

## 数据访问原则

业务代码不使用 `tauri-plugin-sql`，不在 React 中拼接 SQL。跨表写入必须通过 Rust command 的显式事务；PDF 文件、哈希和备份压缩同样放在 Rust 侧。
