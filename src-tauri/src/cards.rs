use crate::{
    canvases,
    models::{
        annotation_from_row, attach_tags, card_from_row, ink_from_row, link_from_row, now,
        Annotation, AnnotationGeometry, AnnotationInput, Card, CardLink, CardOrderUpdate,
        CreateCardInput, MindmapLayout, MindmapLayoutInput, NormalizedBBox, PageInk,
        UpdateCardContentInput, ANNOTATION_COLUMNS, CARD_COLUMNS, CARD_LINK_COLUMNS,
        PAGE_INK_COLUMNS,
    },
    state::AppState,
};
use rusqlite::{params, params_from_iter, types::Value, Connection, OptionalExtension};
use uuid::Uuid;

fn validate_annotation(annotation: &AnnotationInput) -> Result<(), String> {
    if !["highlight", "underline", "text", "rectangle"].contains(&annotation.kind.as_str()) {
        return Err("unsupported annotation kind".into());
    }
    annotation.geometry.validate()
}

pub fn get_card(connection: &Connection, id: &str) -> Result<Card, String> {
    let query = format!("SELECT {CARD_COLUMNS} FROM cards WHERE id = ?1");
    let mut card = connection
        .query_row(&query, params![id], card_from_row)
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "card not found".to_string())?;
    attach_tags(connection, std::slice::from_mut(&mut card)).map_err(|error| error.to_string())?;
    Ok(card)
}

pub fn create_card(state: &AppState, input: CreateCardInput) -> Result<Card, String> {
    // 扫描版 PDF 没有文字层，允许先以标注创建卡片，之后由 OCR 或用户补充内容。
    if input.excerpt.trim().is_empty()
        && input.user_note.trim().is_empty()
        && input.question.trim().is_empty()
        && input.annotation.is_none()
    {
        return Err("卡片需要摘录、笔记、问题或有效的 PDF 标注".into());
    }
    if input.annotation.is_some() && input.source_ref.is_none() {
        return Err("标注需要 PDF 来源".into());
    }
    if let Some(image) = &input.excerpt_image {
        if !image.starts_with("data:image/") {
            return Err("摘录图像必须是 data:image 格式".into());
        }
        if image.len() > 8_000_000 {
            return Err("摘录图像过大，请缩小选区后重试".into());
        }
    }
    if let Some(annotation) = &input.annotation {
        validate_annotation(annotation)?;
    }

    let (document_id, page, bbox) = match input.source_ref {
        Some(source) => {
            source.bbox.validate()?;
            if source.page == 0 {
                return Err("page numbers are one-based".into());
            }
            (
                Some(source.document_id),
                Some(source.page),
                Some(source.bbox),
            )
        }
        None => (None, None, None),
    };

    let canvas_id = input
        .canvas_id
        .clone()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| canvases::DEFAULT_CANVAS_ID.into());
    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    // 非有限值（NaN/Inf）会让 React Flow 的坐标计算彻底失效，直接丢弃。
    let layout_x = input.x.filter(|value| value.is_finite()).unwrap_or(0.0);
    let layout_y = input.y.filter(|value| value.is_finite()).unwrap_or(0.0);
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    if !canvases::canvas_exists(&transaction, &canvas_id)? {
        return Err(format!("画布 {canvas_id} 不存在，请先新建画布"));
    }
    if let Some(parent_id) = &input.parent_id {
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM cards WHERE id = ?1)",
                params![parent_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !exists {
            return Err("parent card not found".into());
        }
    }
    transaction
        .execute(
            "INSERT INTO cards (
                id, document_id, page, bbox_x, bbox_y, bbox_width, bbox_height,
                excerpt, user_note, question, parent_id, sort_order, collapsed,
                due, review_state, created_at, updated_at, excerpt_image, link_aliases
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, ?13, 'new', ?14, ?14, ?15, ?16)",
            params![
                id,
                document_id,
                page,
                bbox.as_ref().map(|value| value.x),
                bbox.as_ref().map(|value| value.y),
                bbox.as_ref().map(|value| value.width),
                bbox.as_ref().map(|value| value.height),
                input.excerpt,
                input.user_note,
                input.question,
                input.parent_id,
                input.sort_order,
                timestamp,
                timestamp,
                input.excerpt_image,
                input.link_aliases.unwrap_or_default(),
            ],
        )
        .map_err(|error| error.to_string())?;

    if let Some(annotation) = input.annotation {
        transaction
            .execute(
                "INSERT INTO annotations (
                    id, card_id, kind, page, geometry_json, style_json, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    Uuid::new_v4().to_string(),
                    id,
                    annotation.kind,
                    page,
                    serde_json::to_string(&annotation.geometry)
                        .map_err(|error| error.to_string())?,
                    serde_json::to_string(&annotation.style).map_err(|error| error.to_string())?,
                    timestamp,
                ],
            )
            .map_err(|error| error.to_string())?;
    }

    transaction
        .execute(
            "INSERT INTO mindmap_layout (card_id, canvas_id, x, y, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, canvas_id, layout_x, layout_y, timestamp],
        )
        .map_err(|error| error.to_string())?;
    let card = get_card(&transaction, &id)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(card)
}

pub fn list_cards(state: &AppState, limit: Option<u32>) -> Result<Vec<Card>, String> {
    let database = state.db()?;
    let query = format!("SELECT {CARD_COLUMNS} FROM cards ORDER BY created_at DESC, id LIMIT ?1");
    let mut statement = database
        .prepare(&query)
        .map_err(|error| error.to_string())?;
    let mut cards = statement
        // 导入 Anki 牌组后单库可能有数千张卡片，上限放宽到 10000 并由前端按需过滤画布。
        .query_map(params![limit.unwrap_or(2000).clamp(1, 10_000)], card_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    attach_tags(&database, &mut cards).map_err(|error| error.to_string())?;
    Ok(cards)
}

pub fn update_card_content(
    state: &AppState,
    input: UpdateCardContentInput,
) -> Result<Card, String> {
    let database = state.db()?;
    let affected = database
        .execute(
            "UPDATE cards SET excerpt = ?1, user_note = ?2, question = ?3,
                link_aliases = COALESCE(?4, link_aliases), updated_at = ?5 WHERE id = ?6",
            params![input.excerpt, input.user_note, input.question, input.link_aliases, now(), input.id],
        )
        .map_err(|error| error.to_string())?;
    if affected == 0 {
        return Err("card not found".into());
    }
    get_card(&database, &input.id)
}

pub fn list_annotations(
    state: &AppState,
    document_id: String,
    pages: Vec<i64>,
) -> Result<Vec<Annotation>, String> {
    if pages.is_empty() {
        return Ok(Vec::new());
    }
    let placeholders = (2..=pages.len() + 1)
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");
    let query = format!(
        "SELECT {ANNOTATION_COLUMNS} FROM annotations AS a
         JOIN cards AS c ON c.id = a.card_id
         WHERE c.document_id = ?1 AND a.page IN ({placeholders})
         ORDER BY a.created_at, a.id"
    );
    let mut values = vec![Value::Text(document_id)];
    values.extend(pages.into_iter().map(Value::Integer));
    let database = state.db()?;
    let mut statement = database
        .prepare(&query)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params_from_iter(values), annotation_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string());
    rows
}

pub fn update_annotation_geometry(
    state: &AppState,
    id: String,
    geometry: AnnotationGeometry,
    bbox: NormalizedBBox,
) -> Result<(), String> {
    geometry.validate()?;
    bbox.validate()?;
    let timestamp = now();
    let geometry_json = serde_json::to_string(&geometry).map_err(|error| error.to_string())?;
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    let card_id: Option<String> = transaction
        .query_row(
            "SELECT card_id FROM annotations WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let card_id = card_id.ok_or_else(|| "annotation not found".to_string())?;
    transaction
        .execute(
            "UPDATE annotations SET geometry_json = ?1, updated_at = ?2 WHERE id = ?3",
            params![geometry_json, timestamp, id],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE cards SET bbox_x = ?1, bbox_y = ?2, bbox_width = ?3,
             bbox_height = ?4, updated_at = ?5 WHERE id = ?6",
            params![bbox.x, bbox.y, bbox.width, bbox.height, timestamp, card_id],
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())
}

pub fn remove_annotation(state: &AppState, id: String, delete_card: bool) -> Result<(), String> {
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    let card_id: Option<String> = transaction
        .query_row(
            "SELECT card_id FROM annotations WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let card_id = card_id.ok_or_else(|| "annotation not found".to_string())?;
    if delete_card {
        transaction
            .execute("DELETE FROM cards WHERE id = ?1", params![card_id])
            .map_err(|error| error.to_string())?;
    } else {
        transaction
            .execute("DELETE FROM annotations WHERE id = ?1", params![id])
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

pub fn list_mindmap_layout(
    state: &AppState,
    canvas_id: Option<String>,
) -> Result<Vec<MindmapLayout>, String> {
    let database = state.db()?;
    let mut statement = database
        .prepare(
            "SELECT card_id, canvas_id, x, y, updated_at FROM mindmap_layout
             WHERE canvas_id = ?1 ORDER BY card_id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![canvas_id.unwrap_or_else(|| "main".into())], |row| {
            Ok(MindmapLayout {
                card_id: row.get(0)?,
                canvas_id: row.get(1)?,
                x: row.get(2)?,
                y: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string());
    rows
}

pub fn save_mindmap_layout(
    state: &AppState,
    layouts: Vec<MindmapLayoutInput>,
) -> Result<(), String> {
    if layouts
        .iter()
        .any(|layout| !layout.x.is_finite() || !layout.y.is_finite())
    {
        return Err("mindmap coordinates must be finite".into());
    }
    if layouts.iter().any(|layout| layout.canvas_id.is_empty()) {
        return Err("canvas_id cannot be empty".into());
    }
    let timestamp = now();
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    for layout in layouts {
        transaction
            .execute(
                "INSERT INTO mindmap_layout (card_id, canvas_id, x, y, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(canvas_id, card_id) DO UPDATE SET
                 x = excluded.x, y = excluded.y, updated_at = excluded.updated_at",
                params![
                    layout.card_id,
                    layout.canvas_id,
                    layout.x,
                    layout.y,
                    timestamp
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

pub fn move_card(
    state: &AppState,
    id: String,
    parent_id: Option<String>,
    sort_order: i64,
) -> Result<Card, String> {
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    get_card(&transaction, &id)?;
    if let Some(parent_id) = &parent_id {
        get_card(&transaction, parent_id)?;
        let creates_cycle: bool = transaction
            .query_row(
                "WITH RECURSIVE subtree(id) AS (
                    SELECT id FROM cards WHERE id = ?1
                    UNION ALL
                    SELECT c.id FROM cards AS c JOIN subtree AS s ON c.parent_id = s.id
                 ) SELECT EXISTS(SELECT 1 FROM subtree WHERE id = ?2)",
                params![id, parent_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if creates_cycle {
            return Err("moving a card below its descendant would create a cycle".into());
        }
    }
    transaction
        .execute(
            "UPDATE cards SET parent_id = ?1, sort_order = ?2, updated_at = ?3 WHERE id = ?4",
            params![parent_id, sort_order, now(), id],
        )
        .map_err(|error| error.to_string())?;
    let card = get_card(&transaction, &id)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(card)
}

/// 大纲编辑 / 拖拽：一次事务提交整层「父节点 + 顺序」变更。
/// 逐条复用 move_card 的防环检查，同一批里先写入的移动会立刻影响后一条的判定；
/// 任何一条失败都整批回滚，避免出现「一半移走一半没移」的树。
pub fn apply_card_order(
    state: &AppState,
    updates: Vec<CardOrderUpdate>,
) -> Result<(), String> {
    if updates.is_empty() {
        return Ok(());
    }
    if updates.len() > 5_000 {
        return Err("too many card order updates".into());
    }
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    let timestamp = now();
    for update in &updates {
        get_card(&transaction, &update.id)?;
        if let Some(parent_id) = &update.parent_id {
            get_card(&transaction, parent_id)?;
            let creates_cycle: bool = transaction
                .query_row(
                    "WITH RECURSIVE subtree(id) AS (
                        SELECT id FROM cards WHERE id = ?1
                        UNION ALL
                        SELECT c.id FROM cards AS c JOIN subtree AS s ON c.parent_id = s.id
                     ) SELECT EXISTS(SELECT 1 FROM subtree WHERE id = ?2)",
                    params![update.id, parent_id],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            if creates_cycle {
                return Err("moving a card below its descendant would create a cycle".into());
            }
        }
        transaction
            .execute(
                "UPDATE cards SET parent_id = ?1, sort_order = ?2, updated_at = ?3 WHERE id = ?4",
                params![update.parent_id, update.sort_order, timestamp, update.id],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

pub fn set_card_collapsed(state: &AppState, id: String, collapsed: bool) -> Result<Card, String> {
    let database = state.db()?;
    let affected = database
        .execute(
            "UPDATE cards SET collapsed = ?1, updated_at = ?2 WHERE id = ?3",
            params![collapsed, now(), id],
        )
        .map_err(|error| error.to_string())?;
    if affected == 0 {
        return Err("card not found".into());
    }
    get_card(&database, &id)
}

/// 从指定画布移除卡片。卡片若仍属于其他画布，只删除该画布的布局行，
/// 不动全局的父子结构；完全离开脑图时才重挂子节点并收回投影。
pub fn remove_card_from_mindmap(
    state: &AppState,
    id: String,
    canvas_id: Option<String>,
) -> Result<(), String> {
    let canvas_id = canvas_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| canvases::DEFAULT_CANVAS_ID.into());
    let timestamp = now();
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    let old_parent: Option<Option<String>> = transaction
        .query_row(
            "SELECT parent_id FROM cards WHERE id = ?1",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let old_parent = old_parent.ok_or_else(|| "card not found".to_string())?;
    transaction
        .execute(
            "DELETE FROM mindmap_layout WHERE card_id = ?1 AND canvas_id = ?2",
            params![id, canvas_id],
        )
        .map_err(|error| error.to_string())?;
    let still_visible: bool = transaction
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM mindmap_layout WHERE card_id = ?1)",
            params![id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !still_visible {
        transaction
            .execute(
                "UPDATE cards SET parent_id = ?1, updated_at = ?2 WHERE parent_id = ?3",
                params![old_parent, timestamp, id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE cards SET surface_mindmap = 0, parent_id = NULL, updated_at = ?1 WHERE id = ?2",
                params![timestamp, id],
            )
            .map_err(|error| error.to_string())?;
    }
    canvases::sync_mindmap_surface(&transaction)?;
    transaction.commit().map_err(|error| error.to_string())
}

pub fn delete_card(state: &AppState, id: String) -> Result<(), String> {
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    let affected = transaction
        .execute("DELETE FROM cards WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    if affected == 0 {
        return Err("card not found".into());
    }
    transaction.commit().map_err(|error| error.to_string())
}

/// 批量清空指定画布里的卡片，返回受影响数量。
///
/// `remove`：只删该画布的布局行；仍属于其他画布的卡片保持可见，
/// 完全离开脑图的卡片才收回 surface_mindmap 并断开父子引用。
/// `delete`：彻底删除该画布的卡片本体（会级联清掉它在所有画布的布局，
/// 因此 UI 必须提示这一档会影响其他画布）。
pub fn clear_mindmap_cards(
    state: &AppState,
    mode: String,
    canvas_id: Option<String>,
) -> Result<u32, String> {
    if mode != "remove" && mode != "delete" {
        return Err("清空模式只能是 remove 或 delete".into());
    }
    let canvas_id = canvas_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| canvases::DEFAULT_CANVAS_ID.into());
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    let count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM mindmap_layout WHERE canvas_id = ?1",
            params![canvas_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;

    if mode == "remove" {
        transaction
            .execute("DELETE FROM mindmap_layout WHERE canvas_id = ?1", params![canvas_id])
            .map_err(|error| error.to_string())?;
        // 只对「已不在任何画布」的卡片断父子关系，避免破坏其他画布的树。
        transaction
            .execute(
                "UPDATE cards SET parent_id = NULL, updated_at = ?1
                 WHERE parent_id IS NOT NULL AND parent_id IN (
                    SELECT id FROM cards c
                    WHERE NOT EXISTS (SELECT 1 FROM mindmap_layout l WHERE l.card_id = c.id)
                 )",
                params![now()],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE cards SET parent_id = NULL, collapsed = 0, updated_at = ?1
                 WHERE parent_id IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM mindmap_layout l WHERE l.card_id = cards.id
                 )",
                params![now()],
            )
            .map_err(|error| error.to_string())?;
        canvases::sync_mindmap_surface(&transaction)?;
    } else {
        // cards.parent_id 是自引用外键（ON DELETE SET NULL）。逐行级联会在批量删除时
        // 反复触发隐式 FK 更新，先把所有父子引用断开再删，避免递归卡死。
        transaction
            .execute(
                "UPDATE cards SET parent_id = NULL WHERE parent_id IS NOT NULL",
                [],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM cards WHERE id IN (
                    SELECT card_id FROM mindmap_layout WHERE canvas_id = ?1
                 )",
                params![canvas_id],
            )
            .map_err(|error| error.to_string())?;
        canvases::sync_mindmap_surface(&transaction)?;
    }

    transaction.commit().map_err(|error| error.to_string())?;
    Ok(count as u32)
}

/// 规范化标签：去空白与前置 #，去重，限制数量与长度。
pub fn set_card_tags(state: &AppState, card_id: String, tags: Vec<String>) -> Result<Card, String> {
    let mut normalized: Vec<String> = Vec::new();
    for tag in tags {
        let value = tag.trim().trim_start_matches('#').trim().to_string();
        if value.is_empty() {
            continue;
        }
        if value.chars().count() > 24 {
            return Err("单个标签不能超过 24 个字符".into());
        }
        if !normalized.contains(&value) {
            normalized.push(value);
        }
    }
    if normalized.len() > 12 {
        return Err("每张卡片最多 12 个标签".into());
    }

    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    let exists: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM cards WHERE id = ?1",
            params![card_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if exists == 0 {
        return Err("card not found".into());
    }
    transaction
        .execute("DELETE FROM card_tags WHERE card_id = ?1", params![card_id])
        .map_err(|error| error.to_string())?;
    let timestamp = now();
    for tag in &normalized {
        transaction
            .execute(
                "INSERT INTO card_tags (card_id, tag, created_at) VALUES (?1, ?2, ?3)",
                params![card_id, tag, timestamp],
            )
            .map_err(|error| error.to_string())?;
    }
    let card = get_card(&transaction, &card_id)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(card)
}

/// 供标签输入框做候选提示，按使用频率排序。
pub fn list_tags(state: &AppState) -> Result<Vec<String>, String> {
    let database = state.db()?;
    let mut statement = database
        .prepare("SELECT tag FROM card_tags GROUP BY tag ORDER BY COUNT(*) DESC, tag LIMIT 200")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn list_card_links(state: &AppState) -> Result<Vec<CardLink>, String> {
    let database = state.db()?;
    let query = format!("SELECT {CARD_LINK_COLUMNS} FROM card_links ORDER BY created_at, id");
    let mut statement = database
        .prepare(&query)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], link_from_row)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn create_card_link(
    state: &AppState,
    source_card_id: String,
    target_card_id: String,
) -> Result<CardLink, String> {
    if source_card_id == target_card_id {
        return Err("不能把卡片链接到自身".into());
    }
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    let existing: Option<CardLink> = transaction
        .query_row(
            &format!("SELECT {CARD_LINK_COLUMNS} FROM card_links WHERE source_card_id = ?1 AND target_card_id = ?2"),
            params![source_card_id, target_card_id],
            link_from_row,
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(link) = existing {
        return Ok(link);
    }
    let count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM cards WHERE id IN (?1, ?2)",
            params![source_card_id, target_card_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if count != 2 {
        return Err("卡片不存在".into());
    }
    let id = Uuid::new_v4().to_string();
    transaction
        .execute(
            "INSERT INTO card_links (id, source_card_id, target_card_id, label, created_at)
             VALUES (?1, ?2, ?3, '', ?4)",
            params![id, source_card_id, target_card_id, now()],
        )
        .map_err(|error| error.to_string())?;
    let link = transaction
        .query_row(
            &format!("SELECT {CARD_LINK_COLUMNS} FROM card_links WHERE id = ?1"),
            params![id],
            link_from_row,
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(link)
}

pub fn delete_card_link(state: &AppState, id: String) -> Result<(), String> {
    let database = state.db()?;
    let affected = database
        .execute("DELETE FROM card_links WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    if affected == 0 {
        return Err("链接不存在".into());
    }
    Ok(())
}

pub fn list_page_inks(
    state: &AppState,
    document_id: String,
    pages: Vec<i64>,
) -> Result<Vec<PageInk>, String> {
    if pages.is_empty() {
        return Ok(Vec::new());
    }
    let database = state.db()?;
    let placeholders = vec!["?"; pages.len()].join(", ");
    let query = format!(
        "SELECT {PAGE_INK_COLUMNS} FROM page_inks
         WHERE document_id = ?1 AND page IN ({placeholders}) ORDER BY page, created_at"
    );
    let mut values: Vec<Value> = vec![Value::Text(document_id)];
    values.extend(pages.into_iter().map(Value::Integer));
    let mut statement = database
        .prepare(&query)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params_from_iter(values), ink_from_row)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn validate_ink_style(style: &serde_json::Value) -> Result<(), String> {
    let points = style
        .get("points")
        .and_then(|value| value.as_array())
        .ok_or("墨迹缺少 points")?;
    if points.len() < 2 {
        return Err("墨迹至少需要两个点".into());
    }
    for point in points {
        let pair = point.as_array().ok_or("墨迹点格式错误")?;
        if pair.len() != 2 {
            return Err("墨迹点必须是 [x, y]".into());
        }
        for value in pair {
            let number = value.as_f64().ok_or("墨迹点必须是数字")?;
            if !(0.0..=1.0).contains(&number) {
                return Err("墨迹点必须归一化到 0–1".into());
            }
        }
    }
    let width = style
        .get("width")
        .and_then(|value| value.as_f64())
        .unwrap_or(0.002);
    if !(0.0005..=0.05).contains(&width) {
        return Err("墨迹宽度超出范围".into());
    }
    Ok(())
}

pub fn create_page_ink(
    state: &AppState,
    document_id: String,
    page: u32,
    bbox: NormalizedBBox,
    style: serde_json::Value,
) -> Result<PageInk, String> {
    if page == 0 {
        return Err("page numbers are one-based".into());
    }
    bbox.validate()?;
    validate_ink_style(&style)?;
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    let exists: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM documents WHERE id = ?1",
            params![document_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if exists == 0 {
        return Err("文档不存在".into());
    }
    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    transaction
        .execute(
            "INSERT INTO page_inks
             (id, document_id, page, bbox_x, bbox_y, bbox_width, bbox_height, style_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
            params![
                id,
                document_id,
                page,
                bbox.x,
                bbox.y,
                bbox.width,
                bbox.height,
                serde_json::to_string(&style).map_err(|error| error.to_string())?,
                timestamp
            ],
        )
        .map_err(|error| error.to_string())?;
    let ink = transaction
        .query_row(
            &format!("SELECT {PAGE_INK_COLUMNS} FROM page_inks WHERE id = ?1"),
            params![id],
            ink_from_row,
        )
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(ink)
}

pub fn delete_page_ink(state: &AppState, id: String) -> Result<(), String> {
    let database = state.db()?;
    let affected = database
        .execute("DELETE FROM page_inks WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    if affected == 0 {
        return Err("墨迹不存在".into());
    }
    Ok(())
}

fn join_unique(values: impl IntoIterator<Item = String>) -> String {
    let mut seen: Vec<String> = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() || seen.iter().any(|item| item == trimmed) {
            continue;
        }
        seen.push(trimmed.to_string());
    }
    seen.join("\n\n")
}

/// 多张卡片合并为第一张：文本合并、子节点与标注迁移、标签取并集，其余卡片删除。
pub fn merge_cards(state: &AppState, card_ids: Vec<String>) -> Result<Card, String> {
    let mut unique: Vec<String> = Vec::new();
    for id in card_ids {
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    if unique.len() < 2 {
        return Err("至少选择两张卡片才能合并".into());
    }

    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    let mut cards = Vec::new();
    for id in &unique {
        cards.push(get_card(&transaction, id)?);
    }
    let mut document_ids: Vec<String> = cards
        .iter()
        .filter_map(|card| {
            card.source_ref
                .as_ref()
                .map(|source| source.document_id.clone())
        })
        .collect();
    document_ids.sort();
    document_ids.dedup();
    if document_ids.len() > 1 {
        return Err("不能合并来自不同 PDF 的卡片".into());
    }

    let target = cards[0].clone();
    let others: Vec<Card> = cards[1..].to_vec();
    // 若主体卡片的父节点正好被合并，把主体提升到祖父节点，避免合并后变成孤儿。
    if let Some(parent_id) = target.parent_id.as_ref() {
        if let Some(parent) = others.iter().find(|card| &card.id == parent_id) {
            transaction
                .execute(
                    "UPDATE cards SET parent_id = ?1 WHERE id = ?2",
                    params![parent.parent_id, target.id],
                )
                .map_err(|error| error.to_string())?;
        }
    }

    let excerpt = join_unique(cards.iter().map(|card| card.excerpt.clone()));
    let user_note = join_unique(cards.iter().map(|card| card.user_note.clone()));
    let question = if target.question.trim().is_empty() {
        cards
            .iter()
            .map(|card| card.question.trim())
            .find(|value| !value.is_empty())
            .unwrap_or("")
            .to_string()
    } else {
        target.question.clone()
    };

    // 目标卡片若没有 PDF 来源，继承被合并卡片中第一个来源，避免标注失去文档归属。
    let source = if target.source_ref.is_some() {
        None
    } else {
        cards.iter().find_map(|card| card.source_ref.as_ref())
    };
    let (document_id, page, bbox_x, bbox_y, bbox_width, bbox_height) = match source {
        Some(source) => (
            Some(source.document_id.clone()),
            Some(source.page as i64),
            Some(source.bbox.x),
            Some(source.bbox.y),
            Some(source.bbox.width),
            Some(source.bbox.height),
        ),
        None => (None, None, None, None, None, None),
    };

    // 别名合并：分号分隔、去重，保留各卡所有关键词。
    let link_aliases = {
        let mut seen: Vec<String> = Vec::new();
        for card in &cards {
            for alias in card.link_aliases.split(';') {
                let trimmed = alias.trim();
                if !trimmed.is_empty() && !seen.iter().any(|item| item == trimmed) {
                    seen.push(trimmed.to_string());
                }
            }
        }
        seen.join(";")
    };

    transaction
        .execute(
            "UPDATE cards SET excerpt = ?1, user_note = ?2, question = ?3,
                surface_pdf = ?4, surface_mindmap = ?5, surface_review = ?6, updated_at = ?7,
                document_id = COALESCE(?8, document_id), page = COALESCE(?9, page),
                bbox_x = COALESCE(?10, bbox_x), bbox_y = COALESCE(?11, bbox_y),
                bbox_width = COALESCE(?12, bbox_width), bbox_height = COALESCE(?13, bbox_height),
                excerpt_image = COALESCE(excerpt_image, ?14), link_aliases = ?16
             WHERE id = ?15",
            params![
                excerpt,
                user_note,
                question,
                cards.iter().any(|card| card.surface_pdf) as i64,
                cards.iter().any(|card| card.surface_mindmap) as i64,
                cards.iter().any(|card| card.surface_review) as i64,
                now(),
                document_id,
                page,
                bbox_x,
                bbox_y,
                bbox_width,
                bbox_height,
                cards.iter().find_map(|card| card.excerpt_image.clone()),
                target.id,
                link_aliases,
            ],
        )
        .map_err(|error| error.to_string())?;

    for other in &others {
        transaction
            .execute(
                "UPDATE cards SET parent_id = ?1 WHERE parent_id = ?2",
                params![target.id, other.id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE annotations SET card_id = ?1 WHERE card_id = ?2",
                params![target.id, other.id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT OR IGNORE INTO card_tags (card_id, tag, created_at)
                 SELECT ?1, tag, created_at FROM card_tags WHERE card_id = ?2",
                params![target.id, other.id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE OR IGNORE card_links SET source_card_id = ?1 WHERE source_card_id = ?2",
                params![target.id, other.id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE OR IGNORE card_links SET target_card_id = ?1 WHERE target_card_id = ?2",
                params![target.id, other.id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "DELETE FROM mindmap_layout WHERE card_id = ?1",
                params![other.id],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute("DELETE FROM cards WHERE id = ?1", params![other.id])
            .map_err(|error| error.to_string())?;
    }

    transaction
        .execute(
            "DELETE FROM card_links WHERE source_card_id = target_card_id",
            [],
        )
        .map_err(|error| error.to_string())?;
    let merged = get_card(&transaction, &target.id)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(merged)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::test_state;

    fn input(question: &str, parent_id: Option<String>) -> CreateCardInput {
        CreateCardInput {
            source_ref: None,
            excerpt: String::new(),
            user_note: String::new(),
            question: question.into(),
            parent_id,
            sort_order: 0,
            annotation: None,
            excerpt_image: None,
            link_aliases: None,
            canvas_id: None,
            x: None,
            y: None,
        }
    }

    #[test]
    fn create_card_initializes_review_and_layout() {
        let (_directory, state) = test_state();
        let card = create_card(&state, input("question", None)).unwrap();
        assert_eq!(card.elapsed_days, 0.0);
        assert_eq!(card.scheduled_days, 0);
        assert_eq!(card.learning_steps, 0);
        assert_eq!(list_mindmap_layout(&state, None).unwrap().len(), 1);
    }

    fn layout_position(state: &AppState, card_id: &str) -> (f64, f64) {
        let database = state.db().unwrap();
        database
            .query_row(
                "SELECT x, y FROM mindmap_layout WHERE card_id = ?1",
                params![card_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    }

    #[test]
    fn create_card_writes_requested_layout_position() {
        let (_directory, state) = test_state();
        let mut payload = input("带落点的卡片", None);
        payload.x = Some(640.0);
        payload.y = Some(360.0);
        let card = create_card(&state, payload).unwrap();
        assert_eq!(layout_position(&state, &card.id), (640.0, 360.0));
    }

    #[test]
    fn create_card_without_position_falls_back_to_origin() {
        let (_directory, state) = test_state();
        let card = create_card(&state, input("没有落点", None)).unwrap();
        // 0,0 是占位值：脑图刷新时会按当前视口中心补位。
        assert_eq!(layout_position(&state, &card.id), (0.0, 0.0));
    }

    #[test]
    fn create_card_ignores_non_finite_position() {
        let (_directory, state) = test_state();
        let mut payload = input("非法落点", None);
        payload.x = Some(f64::NAN);
        payload.y = Some(f64::INFINITY);
        let card = create_card(&state, payload).unwrap();
        assert_eq!(layout_position(&state, &card.id), (0.0, 0.0));
    }

    #[test]
    fn annotation_only_card_is_allowed_for_scanned_pdf() {
        let (directory, state) = test_state();
        {
            let database = state.db().unwrap();
            database
                .execute(
                    "INSERT INTO documents (id, title, stored_path, content_hash, created_at, updated_at)
                     VALUES ('doc-scan', '扫描教材', 'pdfs/scan.pdf', 'scan-hash', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                    [],
                )
                .unwrap();
        }
        let bbox = NormalizedBBox {
            x: 0.1,
            y: 0.1,
            width: 0.4,
            height: 0.1,
        };
        let card = create_card(
            &state,
            CreateCardInput {
                source_ref: Some(crate::models::SourceRef {
                    document_id: "doc-scan".into(),
                    page: 1,
                    bbox: bbox.clone(),
                }),
                excerpt: String::new(),
                user_note: String::new(),
                question: String::new(),
                parent_id: None,
                sort_order: 0,
                excerpt_image: None,
                link_aliases: None,
                annotation: Some(AnnotationInput {
                    kind: "highlight".into(),
                    geometry: AnnotationGeometry { rects: vec![bbox] },
                    style: serde_json::json!({}),
                }),
                canvas_id: None,
                x: None,
                y: None,
            },
        )
        .unwrap();
        assert_eq!(card.source_ref.as_ref().map(|source| source.page), Some(1));
        assert!(card.excerpt.is_empty());
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn tags_are_normalized_and_replaced_atomically() {
        let (directory, state) = test_state();
        let card = create_card(
            &state,
            CreateCardInput {
                source_ref: None,
                excerpt: String::new(),
                user_note: String::new(),
                question: "带标签的卡片".into(),
                parent_id: None,
                sort_order: 0,
                excerpt_image: None,
                link_aliases: None,
                annotation: None,
                canvas_id: None,
                x: None,
                y: None,
            },
        )
        .unwrap();

        let updated = set_card_tags(
            &state,
            card.id.clone(),
            vec![
                " #认知 ".into(),
                "认知".into(),
                "学习方法 ".into(),
                "   ".into(),
            ],
        )
        .unwrap();
        assert_eq!(updated.tags, vec!["学习方法", "认知"]);

        let tags = list_tags(&state).unwrap();
        assert!(tags.contains(&"认知".to_string()));
        assert_eq!(tags.iter().filter(|tag| tag.as_str() == "认知").count(), 1);

        let cleared = set_card_tags(&state, card.id.clone(), vec![]).unwrap();
        assert!(cleared.tags.is_empty());
        assert!(set_card_tags(&state, card.id.clone(), vec!["x".repeat(25)]).is_err());
        assert!(set_card_tags(&state, "missing".into(), vec!["a".into()]).is_err());
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn links_are_idempotent_and_removable() {
        let (directory, state) = test_state();
        let first = create_card(&state, input("第一张", None)).unwrap();
        let second = create_card(&state, input("第二张", None)).unwrap();

        let link = create_card_link(&state, first.id.clone(), second.id.clone()).unwrap();
        let duplicate = create_card_link(&state, first.id.clone(), second.id.clone()).unwrap();
        assert_eq!(link.id, duplicate.id);
        assert_eq!(list_card_links(&state).unwrap().len(), 1);
        assert!(create_card_link(&state, first.id.clone(), first.id.clone()).is_err());
        assert!(create_card_link(&state, "missing".into(), second.id.clone()).is_err());

        delete_card_link(&state, link.id).unwrap();
        assert!(list_card_links(&state).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn page_ink_roundtrip_and_validation() {
        let (directory, state) = test_state();
        {
            let database = state.db().unwrap();
            database
                .execute(
                    "INSERT INTO documents (id, title, stored_path, content_hash, created_at, updated_at)
                     VALUES ('doc-ink', '墨迹文档', 'pdfs/ink.pdf', 'ink-hash', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                    [],
                )
                .unwrap();
        }
        let bbox = NormalizedBBox {
            x: 0.1,
            y: 0.1,
            width: 0.3,
            height: 0.3,
        };
        let style = serde_json::json!({
            "color": "#e05b4a",
            "width": 0.003,
            "points": [[0.1, 0.1], [0.3, 0.2], [0.25, 0.4]]
        });
        let ink = create_page_ink(&state, "doc-ink".into(), 2, bbox.clone(), style).unwrap();
        assert_eq!(ink.page, 2);

        let page_two = list_page_inks(&state, "doc-ink".into(), vec![2]).unwrap();
        assert_eq!(page_two.len(), 1);
        assert!(list_page_inks(&state, "doc-ink".into(), vec![1])
            .unwrap()
            .is_empty());

        let bad_style = serde_json::json!({ "points": [[0.1, 0.1]] });
        assert!(create_page_ink(&state, "doc-ink".into(), 2, bbox, bad_style).is_err());
        assert!(create_page_ink(
            &state,
            "missing".into(),
            1,
            NormalizedBBox {
                x: 0.1,
                y: 0.1,
                width: 0.2,
                height: 0.2
            },
            serde_json::json!({ "points": [[0.1, 0.1], [0.2, 0.2]] })
        )
        .is_err());

        delete_page_ink(&state, ink.id).unwrap();
        assert!(list_page_inks(&state, "doc-ink".into(), vec![2])
            .unwrap()
            .is_empty());
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn merge_cards_combines_text_and_moves_children_and_tags() {
        let (directory, state) = test_state();
        {
            let database = state.db().unwrap();
            database
                .execute(
                    "INSERT INTO documents (id, title, stored_path, content_hash, created_at, updated_at)
                     VALUES ('doc-merge', '合并文档', 'pdfs/merge.pdf', 'merge-hash', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                    [],
                )
                .unwrap();
        }
        let first = create_card(
            &state,
            CreateCardInput {
                excerpt: "第一段摘录".into(),
                ..input("主卡片", None)
            },
        )
        .unwrap();
        let bbox = NormalizedBBox {
            x: 0.1,
            y: 0.1,
            width: 0.3,
            height: 0.2,
        };
        let second = create_card(
            &state,
            CreateCardInput {
                source_ref: Some(crate::models::SourceRef {
                    document_id: "doc-merge".into(),
                    page: 3,
                    bbox: bbox.clone(),
                }),
                excerpt: "第二段摘录".into(),
                annotation: Some(AnnotationInput {
                    kind: "highlight".into(),
                    geometry: AnnotationGeometry { rects: vec![bbox] },
                    style: serde_json::json!({}),
                }),
                ..input("", None)
            },
        )
        .unwrap();
        let child = create_card(&state, input("子卡片", Some(second.id.clone()))).unwrap();

        set_card_tags(&state, first.id.clone(), vec!["认知".into()]).unwrap();
        set_card_tags(
            &state,
            second.id.clone(),
            vec!["方法".into(), "认知".into()],
        )
        .unwrap();

        let merged = merge_cards(&state, vec![first.id.clone(), second.id.clone()]).unwrap();
        assert_eq!(merged.excerpt, "第一段摘录\n\n第二段摘录");
        assert_eq!(merged.tags, vec!["方法", "认知"]);
        assert_eq!(merged.question, "主卡片");

        let reparented = get_card(&state.db().unwrap(), &child.id).unwrap();
        assert_eq!(reparented.parent_id.as_deref(), Some(first.id.as_str()));
        assert!(get_card(&state.db().unwrap(), &second.id).is_err());

        let annotations = list_annotations(&state, "doc-merge".into(), vec![3]).unwrap();
        assert_eq!(annotations.len(), 1);
        assert_eq!(annotations[0].card_id, first.id);
        assert!(merge_cards(&state, vec![first.id.clone()]).is_err());
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn apply_card_order_moves_and_renumbers_in_one_batch() {
        let (_directory, state) = test_state();
        let a = create_card(&state, input("a", None)).unwrap();
        let b = create_card(&state, input("b", None)).unwrap();
        let c = create_card(&state, input("c", None)).unwrap();
        apply_card_order(
            &state,
            vec![
                CardOrderUpdate { id: c.id.clone(), parent_id: Some(a.id.clone()), sort_order: 0 },
                CardOrderUpdate { id: b.id.clone(), parent_id: None, sort_order: 0 },
                CardOrderUpdate { id: a.id.clone(), parent_id: None, sort_order: 1 },
            ],
        )
        .unwrap();
        let moved = get_card(&state.db().unwrap(), &c.id).unwrap();
        assert_eq!(moved.parent_id.as_deref(), Some(a.id.as_str()));
        assert_eq!(moved.sort_order, 0);
        let first = get_card(&state.db().unwrap(), &a.id).unwrap();
        assert_eq!(first.sort_order, 1);
        let second = get_card(&state.db().unwrap(), &b.id).unwrap();
        assert_eq!(second.sort_order, 0);
    }

    #[test]
    fn apply_card_order_rejects_cycle_and_rolls_back_batch() {
        let (_directory, state) = test_state();
        let parent = create_card(&state, input("parent", None)).unwrap();
        let child = create_card(&state, input("child", Some(parent.id.clone()))).unwrap();
        let other = create_card(&state, input("other", None)).unwrap();
        let error = apply_card_order(
            &state,
            vec![
                // 第一条本身合法；第二条把父节点挂到自己的子节点下面，形成环。
                CardOrderUpdate { id: other.id.clone(), parent_id: None, sort_order: 7 },
                CardOrderUpdate { id: parent.id.clone(), parent_id: Some(child.id.clone()), sort_order: 0 },
            ],
        )
        .unwrap_err();
        assert!(error.contains("cycle"));
        // 整批回滚：第一条也不该落库。
        let untouched = get_card(&state.db().unwrap(), &other.id).unwrap();
        assert_ne!(untouched.sort_order, 7);
    }

    #[test]
    fn move_card_rejects_cycles() {
        let (_directory, state) = test_state();
        let parent = create_card(&state, input("parent", None)).unwrap();
        let child = create_card(&state, input("child", Some(parent.id.clone()))).unwrap();
        let error = move_card(&state, parent.id.clone(), Some(child.id), 0).unwrap_err();
        assert!(error.contains("cycle"));
        assert_eq!(
            get_card(&state.db().unwrap(), &parent.id)
                .unwrap()
                .parent_id,
            None
        );
    }

    #[test]
    fn removing_from_mindmap_reparents_children_and_keeps_card() {
        let (_directory, state) = test_state();
        let root = create_card(&state, input("root", None)).unwrap();
        let middle = create_card(&state, input("middle", Some(root.id.clone()))).unwrap();
        let child = create_card(&state, input("child", Some(middle.id.clone()))).unwrap();
        remove_card_from_mindmap(&state, middle.id.clone(), None).unwrap();
        let database = state.db().unwrap();
        assert_eq!(
            get_card(&database, &child.id).unwrap().parent_id,
            Some(root.id)
        );
        assert!(!get_card(&database, &middle.id).unwrap().surface_mindmap);
        drop(database);
        assert!(list_mindmap_layout(&state, None)
            .unwrap()
            .iter()
            .all(|layout| layout.card_id != middle.id));
    }

    #[test]
    fn clear_mindmap_cards_remove_keeps_cards_but_drops_projection_and_layout() {
        let (_directory, state) = test_state();
        let root = create_card(&state, input("root", None)).unwrap();
        create_card(&state, input("child", Some(root.id))).unwrap();
        let count = clear_mindmap_cards(&state, "remove".into(), None).unwrap();
        assert_eq!(count, 2);

        let database = state.db().unwrap();
        let total: i64 = database
            .query_row("SELECT COUNT(*) FROM cards", [], |row| row.get(0))
            .unwrap();
        let visible: i64 = database
            .query_row(
                "SELECT COUNT(*) FROM cards WHERE surface_mindmap = 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let parents: i64 = database
            .query_row(
                "SELECT COUNT(*) FROM cards WHERE parent_id IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let layouts: i64 = database
            .query_row("SELECT COUNT(*) FROM mindmap_layout", [], |row| row.get(0))
            .unwrap();
        drop(database);
        assert_eq!(total, 2);
        assert_eq!(visible, 0);
        assert_eq!(parents, 0);
        assert_eq!(layouts, 0);
        assert_eq!(list_cards(&state, None).unwrap().len(), 2);
    }

    #[test]
    fn clear_mindmap_cards_delete_cascades_and_rejects_bad_mode() {
        let (_directory, state) = test_state();
        let first = create_card(&state, input("first", None)).unwrap();
        let second = create_card(&state, input("second", Some(first.id))).unwrap();
        set_card_tags(&state, second.id.clone(), vec!["标签".into()]).unwrap();
        assert!(clear_mindmap_cards(&state, "bogus".into(), None).is_err());

        let count = clear_mindmap_cards(&state, "delete".into(), None).unwrap();
        assert_eq!(count, 2);
        let database = state.db().unwrap();
        for table in ["cards", "card_tags", "card_links", "review_logs", "annotations", "mindmap_layout"] {
            let remaining: i64 = database
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| row.get(0))
                .unwrap();
            assert_eq!(remaining, 0, "{table} 应被级联清空");
        }
        drop(database);
        // 重复清空是幂等的。
        assert_eq!(clear_mindmap_cards(&state, "delete".into(), None).unwrap(), 0);
    }
}
