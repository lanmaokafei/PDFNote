//! 脑图画布：同一份文档可以有多张画布，也可以有不属于任何文档的全局画布。
//!
//! 归属关系直接复用 `mindmap_layout` 的复合主键 (canvas_id, card_id)：
//! 某卡片在该画布有一行布局，就表示它出现在这张画布里。
//! `cards.surface_mindmap` 因此是「是否在任意画布中出现」的派生开关。

use crate::{
    models::{now, CreateMindmapCanvasInput, MindmapCanvas},
    state::AppState,
};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

pub const DEFAULT_CANVAS_ID: &str = "main";

fn canvas_from_row(row: &rusqlite::Row<'_>) -> Result<MindmapCanvas, rusqlite::Error> {
    let card_count: i64 = row.get(5)?;
    Ok(MindmapCanvas {
        id: row.get(0)?,
        document_id: row.get(1)?,
        name: row.get(2)?,
        created_at: row.get(3)?,
        updated_at: row.get(4)?,
        card_count: card_count.max(0) as u32,
    })
}

const CANVAS_SELECT: &str = "SELECT c.id, c.document_id, c.name, c.created_at, c.updated_at,
       (SELECT COUNT(*) FROM mindmap_layout l WHERE l.canvas_id = c.id)
       FROM mindmap_canvases c";

pub fn get_canvas(connection: &Connection, id: &str) -> Result<MindmapCanvas, String> {
    let query = format!("{CANVAS_SELECT} WHERE c.id = ?1");
    connection
        .query_row(&query, params![id], canvas_from_row)
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "画布不存在".to_string())
}

pub fn canvas_exists(connection: &Connection, id: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM mindmap_canvases WHERE id = ?1)",
            params![id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
}

/// `document_id = Some(d)`：返回全局画布 + 该文档的画布（文档工作台用）。
/// `None`：返回全部画布（独立脑图视图用）。
pub fn list_canvases(
    state: &AppState,
    document_id: Option<String>,
) -> Result<Vec<MindmapCanvas>, String> {
    let database = state.db()?;
    let query = format!(
        "{CANVAS_SELECT}
         WHERE ?1 IS NULL OR c.document_id IS NULL OR c.document_id = ?1
         ORDER BY (c.document_id IS NULL) DESC, c.created_at, c.id"
    );
    let mut statement = database.prepare(&query).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![document_id], canvas_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

pub fn create_canvas(
    state: &AppState,
    input: CreateMindmapCanvasInput,
) -> Result<MindmapCanvas, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() || name.chars().count() > 60 {
        return Err("画布名称需为 1–60 个字符".into());
    }
    let id = input.id.unwrap_or_default().trim().to_string();
    let id = if id.is_empty() {
        Uuid::new_v4().to_string()
    } else {
        id
    };
    if id == DEFAULT_CANVAS_ID || id.is_empty() || id.chars().count() > 80 {
        return Err("画布 ID 不合法（main 为系统保留）".into());
    }
    let timestamp = now();
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    if let Some(document_id) = &input.document_id {
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM documents WHERE id = ?1)",
                params![document_id],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if !exists {
            return Err("画布绑定的文档不存在".into());
        }
    }
    transaction
        .execute(
            "INSERT INTO mindmap_canvases (id, document_id, name, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?4)",
            params![id, input.document_id, name, timestamp],
        )
        .map_err(|error| format!("创建画布失败（ID 可能已存在）：{error}"))?;
    let canvas = get_canvas(&transaction, &id)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(canvas)
}

pub fn rename_canvas(state: &AppState, id: String, name: String) -> Result<MindmapCanvas, String> {
    let name = name.trim().to_string();
    if name.is_empty() || name.chars().count() > 60 {
        return Err("画布名称需为 1–60 个字符".into());
    }
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    let affected = transaction
        .execute(
            "UPDATE mindmap_canvases SET name = ?1, updated_at = ?2 WHERE id = ?3",
            params![name, now(), id],
        )
        .map_err(|error| error.to_string())?;
    if affected == 0 {
        return Err("画布不存在".into());
    }
    let canvas = get_canvas(&transaction, &id)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(canvas)
}

/// 删除画布：只移除该画布的布局行与画布本身，卡片内容保留。
/// 若卡片因此不再出现在任何画布，才把 surface_mindmap 收回 0。
/// 返回被移出该画布的卡片数。
pub fn delete_canvas(state: &AppState, id: String) -> Result<u32, String> {
    if id == DEFAULT_CANVAS_ID {
        return Err("默认画布不可删除，可以重命名后继续使用".into());
    }
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    let count: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM mindmap_layout WHERE canvas_id = ?1",
            params![id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM mindmap_layout WHERE canvas_id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM mindmap_canvases WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    sync_mindmap_surface(&transaction)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(count as u32)
}

/// layout 是画布归属的唯一真相，双向对齐 surface_mindmap。
/// 只在删除画布 / 清空画布 / 移除卡片后调用，避免全表扫描成为热路径。
pub fn sync_mindmap_surface(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "UPDATE cards SET surface_mindmap =
                CASE WHEN EXISTS (SELECT 1 FROM mindmap_layout l WHERE l.card_id = cards.id)
                     THEN 1 ELSE 0 END,
                updated_at = ?1
             WHERE surface_mindmap <> CASE WHEN EXISTS
                (SELECT 1 FROM mindmap_layout l WHERE l.card_id = cards.id)
                     THEN 1 ELSE 0 END",
            params![now()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::CreateCardInput;
    use crate::state::test_state;

    fn insert_document(connection: &Connection, id: &str) {
        connection
            .execute(
                "INSERT INTO documents (id, title, stored_path, content_hash, created_at, updated_at)
                 VALUES (?1, ?2, 'pdfs/a.pdf', ?3, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                params![id, format!("文档{id}"), format!("hash-{id}")],
            )
            .unwrap();
    }

    #[test]
    fn fresh_database_has_global_main_canvas() {
        let (_directory, state) = test_state();
        let canvases = list_canvases(&state, None).unwrap();
        assert_eq!(canvases.len(), 1);
        assert_eq!(canvases[0].id, DEFAULT_CANVAS_ID);
        assert!(canvases[0].document_id.is_none());
        assert_eq!(canvases[0].card_count, 0);
    }

    #[test]
    fn create_rename_and_filter_by_document() {
        let (_directory, state) = test_state();
        {
            let database = state.db().unwrap();
            insert_document(&database, "doc-a");
            insert_document(&database, "doc-b");
        }
        let global = create_canvas(&state, CreateMindmapCanvasInput {
            id: Some("global-1".into()), name: "全局草稿".into(), document_id: None,
        }).unwrap();
        let bound = create_canvas(&state, CreateMindmapCanvasInput {
            id: Some("book-1".into()), name: "第一章".into(), document_id: Some("doc-a".into()),
        }).unwrap();
        assert_eq!(global.card_count, 0);
        assert_eq!(bound.document_id.as_deref(), Some("doc-a"));

        let for_a = list_canvases(&state, Some("doc-a".into())).unwrap();
        let mut ids: Vec<_> = for_a.iter().map(|c| c.id.as_str()).collect();
        ids.sort_unstable();
        assert_eq!(ids, vec!["book-1", "global-1", "main"]);

        let all = list_canvases(&state, None).unwrap();
        assert_eq!(all.len(), 3);
        // doc-b 只能看到全局画布，看不到 doc-a 的专属画布。
        let for_b = list_canvases(&state, Some("doc-b".into())).unwrap();
        assert_eq!(for_b.len(), 2);
        assert!(!for_b.iter().any(|c| c.id == "book-1"));

        let renamed = rename_canvas(&state, "book-1".into(), "第一章（重排）".into()).unwrap();
        assert_eq!(renamed.name, "第一章（重排）");
        assert!(rename_canvas(&state, "missing".into(), "x".into()).is_err());
    }

    #[test]
    fn delete_canvas_removes_only_its_layout() {
        let (_directory, state) = test_state();
        let card = crate::cards::create_card(&state, CreateCardInput {
            source_ref: None,
            excerpt: "摘录".into(),
            user_note: "".into(),
            question: "问题".into(),
            parent_id: None,
            canvas_id: None,
            x: None,
            y: None,
            sort_order: 0,
            annotation: None,
            excerpt_image: None,
            link_aliases: None,
        }).unwrap();
        let extra = create_canvas(&state, CreateMindmapCanvasInput {
            id: Some("extra".into()), name: "临时画布".into(), document_id: None,
        }).unwrap();
        assert_eq!(extra.card_count, 0);
        {
            let database = state.db().unwrap();
            database.execute(
                "INSERT INTO mindmap_layout (card_id, canvas_id, x, y, updated_at)
                 VALUES (?1, 'extra', 10, 20, '2026-01-01T00:00:00.000Z')",
                params![card.id],
            ).unwrap();
        }
        let removed = delete_canvas(&state, "extra".into()).unwrap();
        assert_eq!(removed, 1);
        assert!(list_canvases(&state, None).unwrap().iter().all(|c| c.id != "extra"));
        let still_visible: bool = {
            let database = state.db().unwrap();
            database.query_row(
                "SELECT surface_mindmap FROM cards WHERE id = ?1", params![card.id], |row| row.get(0),
            ).unwrap()
        };
        assert!(still_visible, "卡片在 main 画布仍有布局，不应被隐藏");
        assert!(delete_canvas(&state, DEFAULT_CANVAS_ID.into()).is_err());
    }

    #[test]
    fn deleting_last_canvas_membership_hides_card() {
        let (_directory, state) = test_state();
        create_canvas(&state, CreateMindmapCanvasInput {
            id: Some("temp".into()), name: "临时".into(), document_id: None,
        }).unwrap();
        let card = crate::cards::create_card(&state, CreateCardInput {
            source_ref: None, excerpt: "内容".into(), user_note: "".into(), question: "Q".into(),
            parent_id: None, canvas_id: Some("temp".into()), sort_order: 0,
            annotation: None, excerpt_image: None, link_aliases: None,
            x: None, y: None,
        }).unwrap();
        let removed = delete_canvas(&state, "temp".into()).unwrap();
        assert_eq!(removed, 1);
        let visible: bool = {
            let database = state.db().unwrap();
            database.query_row(
                "SELECT surface_mindmap FROM cards WHERE id = ?1", params![card.id], |row| row.get(0),
            ).unwrap()
        };
        assert!(!visible, "卡片已不属于任何画布，surface_mindmap 应收回到 0");
    }
}
