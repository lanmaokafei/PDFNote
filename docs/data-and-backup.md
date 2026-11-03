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
