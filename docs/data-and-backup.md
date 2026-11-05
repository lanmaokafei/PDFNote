# 数据目录、备份格式与恢复

## 应用数据目录

桌面应用启动时由 Tauri `app_data_dir()` 解析，macOS 默认位于：

```text
~/Library/Application Support/com.pdfnote.local/
  pdfnote.db          SQLite 主库（WAL）
  pdfnote.db-wal      SQLite 预写日志
  pdfnote.db-shm      SQLite 共享内存
  pdfs/                去重后的 PDF 副本，按 SHA-256 命名
    <sha256>.pdf
  backups/             自动备份，最多保留 5 个
    auto-YYYYMMDD-HHMMSS.pdfnote.zip
  tmp/                 导入与恢复暂存；启动时清理残留
```

实际路径由 Tauri 按 macOS 应用数据目录规则解析（本机为 `~/Library/Application Support/com.pdfnote.local/`）。数据库和文件均位于应用自己的数据目录内，不需要用户授权任意文件系统访问。

## PDF 文件策略

- 导入时以 64 KiB 流式计算 SHA-256，内容相同直接返回已有文档，不产生第二份副本。
- 副本命名为 `<sha256>.pdf`，避免非法字符、重名和路径注入。
- 数据库 `documents.stored_path` 只保存相对路径 `pdfs/<sha256>.pdf`。
- `original_path` 仅作提示；打开文档始终读取应用目录内副本。
- 文件缺失或哈希不一致时，重新定位候选文件必须与原始哈希完全一致。

## 备份包结构

```text
PDFNote-backup-YYYYMMDD-HHMMSS.zip
  manifest.json
  data/
    pdfnote.db          VACUUM INTO 产生的一致性快照
  pdfs/
    <sha256>.pdf
```

`manifest.json`：

```json
{
  "app": "pdfnote",
  "app_version": "0.1.0",
  "schema_version": 1,
  "exported_at": "2026-11-02T01:00:00.000Z",
  "documents": [
    {
      "id": "uuid",
      "title": "文档标题",
      "stored_path": "pdfs/<sha256>.pdf",
      "content_hash": "<sha256>",
      "file_size": 123456
    }
  ],
  "card_count": 42
}
```

导出前执行 WAL checkpoint，再使用 `VACUUM INTO` 生成数据库快照，保证备份中的 Card、标注、布局、FSRS 状态与审计日志来自同一时点。

## 导入语义

导入先把 zip 解压到 `tmp/import-<uuid>/`，并完成以下校验，全部通过后才修改现有数据：

1. `manifest.json` 存在且应用标识正确。
2. `schema_version` 不高于当前应用支持版本。
3. 数据库 `user_version` 与清单一致，`quick_check` 为 `ok`。
4. 每个清单 PDF 都存在且 SHA-256 一致。
5. zip 内路径经过规范化，拒绝绝对路径、`..` 和非法分量。

### merge（合并）

- 文档按 `content_hash` 去重；同一内容沿用当前库中的文档 ID。
- 卡片按 ID 合并，同 ID 时保留 `updated_at` 较新的复习状态与内容。
- 标注、布局按主键补缺，不覆盖已有的较新布局。
- 复习日志按 `client_event_id` 去重，重复导入不会重复计分。

### overwrite（覆盖）

清空当前逻辑数据后导入备份快照，并补齐缺失 PDF 副本。必须二次确认。PDF 副本按内容哈希复用，不会产生重复。

## 阅读进度

- `documents.last_page` 记录上次停留页，schema v2 新增，默认 1。
- 翻页停止 700ms 后写入，关闭文档时再补一次；不更新 `updated_at`，避免资料库排序与备份新鲜度被翻页触发。
- 备份导入时按清单 `schema_version` 选择列：schema v1 旧包没有 `last_page`，导入后为 1；schema v2 包会一并恢复。

## 多画布与 AnkiDroid 导入（schema v9）

- `mindmap_canvases(id, document_id, name, created_at, updated_at)` 随整库备份往返，已加入 overwrite 的 DELETE 列表、`copy_table_if_present` 与 merge 的复制表清单。
- `document_id` 指向 `documents(id)` 且 `ON DELETE SET NULL`：删书后画布变全局画布，卡片与坐标不丢。
- merge 导入按 `content_hash` 把 `document_id` 重映射到本地文档；找不到对应文档时退化为全局画布。
- **旧备份（schema < 9）兼容**：`ensure_layout_canvases` 在导入后补回 `main`，并为 `mindmap_layout` 里所有未登记的 `canvas_id` 补画布行；迁移 009 还会给「有 `surface_mindmap` 投影但完全没有布局行」的历史卡片补一行 `main` 布局。
- 归属完全由 `mindmap_layout(canvas_id, card_id)` 决定，`surface_mindmap` 是派生开关，导入后统一 `sync_mindmap_surface` 对齐，不需要单独同步一列。
- 画布选择偏好存前端 `localStorage`（`pdfnote.mindmap.canvas[.<documentId>]`），不进数据库、不随备份迁移。
- AnkiDroid txt 不写文件路径到数据库：只在导入时读取一次，产物是普通 `cards` / `card_tags` / `mindmap_layout` 行，因此备份格式没有变化。详见 [多画布脑图与 AnkiDroid 导入](mindmap-canvases.md)。

## 批量清空脑图卡片（0.17.0，不改 schema）

- `clear_mindmap_cards` 单事务执行；0.20.0 起带 `canvasId`：`remove` 只删该画布的 `mindmap_layout` 行（卡片仍在其他画布时不改 `surface_mindmap` 与父子结构），`delete` 删除该画布上的卡片本体并靠外键级联清理关联表（包括其他画布的布局）。
- 清空操作本身不包含在备份里，恢复整库可还原被删除的卡片。

## AI 拆书（schema v8）

- `book_analysis(document_id, mode, chunk_index, page_start, page_end, summary, items_json, pages_json)`：阶段一的块级笔记，`(document_id, mode, chunk_index)` 唯一。
- `book_outline(document_id, mode, outline_json)`：阶段二的层级骨架。0.18.0 起 `outline_json` 里的
  `BookOutline.depth` 记录本次读者所选层数（1–5，默认 2）；这是 JSON 字段，不是新列，**schema 仍为 v8**。
  旧备份的 `outline_json` 没有该字段，反序列化时按 `#[serde(default)]` 回落成 2，读取与写入脑图都不受影响。
- 两表都随整库备份往返；合并导入时连同文档重映射，旧备份没有这些表时自动跳过。
- 读者的层数偏好存前端 `localStorage`（`pdfnote.digest.depth`），不进数据库、不随备份迁移到另一台设备。

## 留白（schema v7）

- `page_notes(id, document_id, page, anchor_y, content, collapsed, color, created_at, updated_at)`。
- `document_id` 外键级联删除：删文档会一并删掉页边草稿。
- 整库备份/恢复包含该表；合并导入按 `content_hash` 重指向本地文档，找不到文档的条目跳过。
- 旧备份（schema < 7）没有该表，导入时自动忽略。

## 标题链接别名（schema v6）

- `cards.link_aliases`：分号分隔的关键词别名，默认空字符串。
- 旧备份（schema < 6）导入时该列补空字符串；schema 6 起随备份完整往返。
- 关键词由卡片标题与别名共同构成，匹配完全在本地完成，不产生网络请求。

## 页面文字缓存（schema v5）

- `page_ocr(document_id, page, lines_json, engine, created_at)` 保存扫描页整页 OCR 的行级文字与归一化坐标，使页面再次打开时无需重新识别。
- 这是**可重建的派生数据**：不设外键、不参与卡片语义，清空该表只会让页面下次打开时重新识别一次。
- 备份导出由 `VACUUM INTO` 自动包含该表；overwrite 导入时若备份含该表则恢复，旧备份无该表则跳过；merge 导入不恢复（自动重建）。
- 行坐标与摘录图像一样都保存在本地，不产生任何网络请求。

## 自动备份

- 应用启动 60 秒后在后台触发；运行期间每 30 分钟检查一次。
- 只有 documents / cards / review_logs 的最新更新时间晚于最近备份开始时才创建新包，否则立即跳过。
- 备份任务运行在 Tauri 线程池，不占用 WebView 主线程。
- PDF 在 ZIP 中使用 Stored 模式，避免对已压缩的 500MB 教材重复 deflate；数据库才使用压缩。
- 写入 `backups/auto-*.pdfnote.zip`，只保留最新 5 份。
- 评分、编辑、拖动等高频操作不触发完整备份，避免阻塞交互；它们已在单一事务内落盘。

## 换机迁移

1. 在旧机器进入「备份与恢复」，导出完整备份。
2. 将 zip 通过任意离线介质复制到新机器。
3. 在新机器安装同版本或更新版本的 PDFNote，启动一次。
4. 打开「备份与恢复」→ 选择备份文件 → 首次迁移建议使用 overwrite，确认后导入。
5. 在资料库逐份打开 PDF，应用会校验文件哈希。
6. 进入复习视图，确认到期队列和近 14 日统计正常。

## 崩溃恢复

- SQLite 使用 WAL + `synchronous=NORMAL` + `foreign_keys=ON` + 5 秒 busy timeout。
- 启动时运行 `PRAGMA quick_check`；失败则阻止继续写入并显示错误。
- `tmp/` 中未完成的导入/恢复暂存会在下次启动清理。
- 所有评分在一个事务中同时更新 Card 与 review_logs；崩溃不会留下半条评分。
- 覆盖导入在单事务内完成，校验失败或中途错误会回滚，不破坏当前数据。
