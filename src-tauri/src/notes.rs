use crate::{
    models::{
        now, page_note_from_row, CreatePageNoteInput, PageNote, UpdatePageNoteInput,
        PAGE_NOTE_COLUMNS,
    },
    state::AppState,
};
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

/// 留白正文上限，避免把整本书粘进一条便签。
const MAX_CONTENT_CHARS: usize = 10_000;
const COLORS: [&str; 4] = ["amber", "green", "blue", "pink"];

fn normalize_color(color: Option<String>) -> String {
    match color {
        Some(value) if COLORS.contains(&value.as_str()) => value,
        _ => COLORS[0].to_string(),
    }
}

fn validate_content(content: &str) -> Result<(), String> {
    if content.chars().count() > MAX_CONTENT_CHARS {
        return Err(format!("留白内容过长（最多 {MAX_CONTENT_CHARS} 字）"));
    }
    Ok(())
}

fn get_note(connection: &Connection, id: &str) -> Result<Option<PageNote>, String> {
    let query = format!("SELECT {PAGE_NOTE_COLUMNS} FROM page_notes WHERE id = ?1");
    connection
        .query_row(&query, params![id], page_note_from_row)
        .optional()
        .map_err(|error| error.to_string())
}

pub fn list_page_notes(state: &AppState, document_id: String) -> Result<Vec<PageNote>, String> {
    let connection = state.db()?;
    let query = format!(
        "SELECT {PAGE_NOTE_COLUMNS} FROM page_notes WHERE document_id = ?1
         ORDER BY page ASC, anchor_y ASC, created_at ASC"
    );
    let mut statement = connection
        .prepare(&query)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![document_id], page_note_from_row)
        .map_err(|error| error.to_string())?;
    let mut notes = Vec::new();
    for row in rows {
        notes.push(row.map_err(|error| error.to_string())?);
    }
    Ok(notes)
}

pub fn create_page_note(state: &AppState, input: CreatePageNoteInput) -> Result<PageNote, String> {
    input.validate()?;
    let connection = state.db()?;
    let exists: Option<i64> = connection
        .query_row(
            "SELECT 1 FROM documents WHERE id = ?1",
            params![input.document_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if exists.is_none() {
        return Err("文档不存在".into());
    }

    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    connection
        .execute(
            "INSERT INTO page_notes (
                id, document_id, page, anchor_y, content, collapsed, color, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, '', 0, ?5, ?6, ?6)",
            params![
                id,
                input.document_id,
                input.page,
                input.anchor_y,
                normalize_color(input.color),
                timestamp,
            ],
        )
        .map_err(|error| error.to_string())?;
    get_note(&connection, &id)?.ok_or_else(|| "留白创建失败".into())
}

pub fn update_page_note(state: &AppState, input: UpdatePageNoteInput) -> Result<PageNote, String> {
    let connection = state.db()?;
    let mut note = get_note(&connection, &input.id)?.ok_or_else(|| "留白不存在".to_string())?;

    if let Some(content) = input.content {
        validate_content(&content)?;
        note.content = content;
    }
    if let Some(anchor_y) = input.anchor_y {
        if !anchor_y.is_finite() || !(0.0..=1.0).contains(&anchor_y) {
            return Err("anchor_y 必须归一化到 0–1".into());
        }
        note.anchor_y = anchor_y;
    }
    if let Some(collapsed) = input.collapsed {
        note.collapsed = collapsed;
    }
    if let Some(color) = input.color {
        note.color = normalize_color(Some(color));
    }

    connection
        .execute(
            "UPDATE page_notes SET content = ?1, anchor_y = ?2, collapsed = ?3, color = ?4,
                updated_at = ?5 WHERE id = ?6",
            params![
                note.content,
                note.anchor_y,
                note.collapsed as i64,
                note.color,
                now(),
                note.id,
            ],
        )
        .map_err(|error| error.to_string())?;
    get_note(&connection, &note.id)?.ok_or_else(|| "留白不存在".into())
}

pub fn delete_page_note(state: &AppState, id: String) -> Result<(), String> {
    let connection = state.db()?;
    let affected = connection
        .execute("DELETE FROM page_notes WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    if affected == 0 {
        return Err("留白不存在".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::test_state;

    fn seed_document(connection: &Connection) {
        connection
            .execute(
                "INSERT INTO documents (
                    id, title, stored_path, original_path, content_hash, file_size,
                    page_count, file_status, last_page, created_at, updated_at
                ) VALUES ('doc1', '测试文档', 'pdfs/a.pdf', NULL, 'hash', 100, 3, 'ready', 1,
                    '2026-11-03T00:00:00.000Z', '2026-11-03T00:00:00.000Z')",
                [],
            )
            .unwrap();
    }

    fn input(page: u32, anchor_y: f64) -> CreatePageNoteInput {
        CreatePageNoteInput {
            document_id: "doc1".into(),
            page,
            anchor_y,
            color: None,
        }
    }

    #[test]
    fn create_list_update_and_delete_roundtrip() {
        let (directory, state) = test_state();
        {
            let connection = state.db().unwrap();
            seed_document(&connection);
        }

        let note = create_page_note(&state, input(2, 0.25)).unwrap();
        assert_eq!(note.page, 2);
        assert_eq!(note.color, "amber");
        assert!(!note.collapsed);
        assert!(note.content.is_empty());

        let updated = update_page_note(
            &state,
            UpdatePageNoteInput {
                id: note.id.clone(),
                content: Some("页边草稿：熵的单位是 bit".into()),
                anchor_y: Some(0.4),
                collapsed: Some(true),
                color: Some("blue".into()),
            },
        )
        .unwrap();
        assert_eq!(updated.content, "页边草稿：熵的单位是 bit");
        assert_eq!(updated.anchor_y, 0.4);
        assert!(updated.collapsed);
        assert_eq!(updated.color, "blue");

        let notes = list_page_notes(&state, "doc1".into()).unwrap();
        assert_eq!(notes.len(), 1);

        delete_page_note(&state, note.id.clone()).unwrap();
        assert!(list_page_notes(&state, "doc1".into()).unwrap().is_empty());
        assert!(delete_page_note(&state, note.id).is_err());
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn rejects_invalid_input() {
        let (directory, state) = test_state();
        {
            let connection = state.db().unwrap();
            seed_document(&connection);
        }
        assert!(create_page_note(&state, input(1, 1.5)).is_err());
        assert!(create_page_note(&state, input(0, 0.1)).is_err());

        let mut missing = input(1, 0.1);
        missing.document_id = "nope".into();
        assert!(create_page_note(&state, missing).is_err());

        let note = create_page_note(&state, input(1, 0.1)).unwrap();
        let too_long = update_page_note(
            &state,
            UpdatePageNoteInput {
                id: note.id,
                content: Some("字".repeat(MAX_CONTENT_CHARS + 1)),
                anchor_y: None,
                collapsed: None,
                color: None,
            },
        );
        assert!(too_long.is_err());
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn deleting_document_cascades_notes() {
        let (directory, state) = test_state();
        {
            let connection = state.db().unwrap();
            seed_document(&connection);
        }
        create_page_note(&state, input(1, 0.1)).unwrap();
        {
            let connection = state.db().unwrap();
            connection
                .execute("DELETE FROM documents WHERE id = 'doc1'", [])
                .unwrap();
        }
        assert!(list_page_notes(&state, "doc1".into()).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&directory);
    }
}
