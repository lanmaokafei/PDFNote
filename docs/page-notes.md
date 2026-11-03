# 留白：页边草稿（0.14.0）

对照 MarginNote 的「留白（extended note）」功能，本期实现**页边模式**：一段不绑定任何文字、
贴在页面右边缘的独立草稿。它和卡片是两种东西——卡片必须来自摘录或手动创建并进入复习，
留白只是页面上的随手记，随时可折叠、可删。

## 使用方式

1. 在 PDF 页面空白处右键 → **「在此页添加留白」**。
2. 便签出现在页面右侧、靠近右键的位置（锚点按右键的纵向比例换算）。
3. 直接输入；**失焦时保存**（输入过程中不写库，避免每敲一个字都开事务）。
4. 头部两个按钮：
   - `−` 折叠成边缘小圆点，点击圆点重新展开；
   - `×` 删除这条留白。
5. 每条留白可以有自己的颜色（`amber` / `green` / `blue` / `pink`，默认 amber），
   数据结构已支持，UI 暂未提供取色入口。

## 数据模型（schema v7）

```sql
CREATE TABLE page_notes (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,          -- 外键 → documents(id) ON DELETE CASCADE
  page INTEGER NOT NULL,
  anchor_y REAL NOT NULL DEFAULT 0.08, -- 归一化纵向锚点 0–1
  content TEXT NOT NULL DEFAULT '',
  collapsed INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT 'amber',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_page_notes_document_page ON page_notes (document_id, page, anchor_y);
```

设计取舍：

- **不绑定 bbox**：留白是页面级草稿，不跟随文字选区移动；需要绑定选区时用卡片。
- **anchor_y 归一化**：缩放、换设备后位置仍然正确。
- **删除文档级联删除留白**：留白离开文档没有意义。
- **一次加载整本文档的留白**：数量远小于标注，不值得做按页懒加载。

## 接口

| 命令 | 说明 |
| --- | --- |
| `list_page_notes(document_id)` | 按页、锚点排序返回全部留白 |
| `create_page_note(input)` | 新建空留白（校验文档存在、页码 ≥ 1、锚点在 0–1） |
| `update_page_note(input)` | 局部更新内容 / 锚点 / 折叠 / 颜色 |
| `delete_page_note(id)` | 删除，不存在时报错 |

内容上限 10 000 字；颜色只接受预设四种，其他值回落到 `amber`。

## 备份与导入

- 整库备份包含 `page_notes`；恢复（overwrite）时先于 `documents` 清空，避免外键失败。
- **合并导入**会按 `content_hash` 把 `document_id` 重指向本地文档；找不到对应文档的留白跳过，
  不会因为外键约束导致整包导入失败。
- 旧备份（schema < 7）没有该表，导入时自动跳过，不影响原有数据。

## 与其它功能的关系

- 留白**不进复习队列**，也不是脑图节点。想让它参与复习：复制内容新建一张独立卡片。
- 手写仍然走 `page_inks`（墨迹），与留白互不影响。
- 文档回忆（遮挡）只处理卡片标注，不遮挡留白。

## 限制

- 只有页边模式：MN 的「嵌入页面、纸面长大」二期再评估（需要改页面渲染管线，与虚拟化滚动冲突）。
- 纯文本，没有 Markdown 渲染、图片粘贴与手写混排。
- 不支持拖动便签改变锚点（可后续加拖拽手柄）。

## 验证

```bash
npm run dev -- --host 127.0.0.1
STEP=notes CARD_COUNT=12 node scripts/mindmap-regression.mjs
```

冒烟覆盖：右键添加 → 便签出现 → 输入并失焦保存（校验 mock 收到的内容）→ 折叠 →
展开 → 删除后消失。Rust 侧另有 3 项测试（增删改查往返、非法输入、文档级联删除）与
1 项 v6→v7 迁移测试。
