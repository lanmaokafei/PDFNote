use crate::{
    models::{
        annotation_from_row, card_from_row, now, Annotation, AnnotationGeometry, AnnotationInput,
        Card, CreateCardInput, MindmapLayout, MindmapLayoutInput, NormalizedBBox,
        UpdateCardContentInput, ANNOTATION_COLUMNS, CARD_COLUMNS,
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
    connection
        .query_row(&query, params![id], card_from_row)
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "card not found".into())
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

    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
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
                due, review_state, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, ?13, 'new', ?14, ?14)",
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
            "INSERT INTO mindmap_layout (card_id, updated_at) VALUES (?1, ?2)",
            params![id, timestamp],
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
    let rows = statement
        .query_map(params![limit.unwrap_or(500).clamp(1, 500)], card_from_row)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string());
    rows
}

pub fn update_card_content(
    state: &AppState,
    input: UpdateCardContentInput,
) -> Result<Card, String> {
    let database = state.db()?;
    let affected = database
        .execute(
            "UPDATE cards SET excerpt = ?1, user_note = ?2, question = ?3, updated_at = ?4 WHERE id = ?5",
            params![input.excerpt, input.user_note, input.question, now(), input.id],
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

pub fn remove_card_from_mindmap(state: &AppState, id: String) -> Result<(), String> {
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
    transaction
        .execute("DELETE FROM mindmap_layout WHERE card_id = ?1", params![id])
        .map_err(|error| error.to_string())?;
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
                annotation: Some(AnnotationInput {
                    kind: "highlight".into(),
                    geometry: AnnotationGeometry { rects: vec![bbox] },
                    style: serde_json::json!({}),
                }),
            },
        )
        .unwrap();
        assert_eq!(card.source_ref.as_ref().map(|source| source.page), Some(1));
        assert!(card.excerpt.is_empty());
        let _ = std::fs::remove_dir_all(&directory);
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
        remove_card_from_mindmap(&state, middle.id.clone()).unwrap();
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
}
