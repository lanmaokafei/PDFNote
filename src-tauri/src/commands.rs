use crate::{
    db::SCHEMA_VERSION,
    models::{card_from_row, BootstrapStatus, Card, CreateCardInput, CARD_COLUMNS},
    state::AppState,
};
use chrono::{SecondsFormat, Utc};
use rusqlite::{params, OptionalExtension};
use tauri::State;
use uuid::Uuid;

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn lock_error() -> String {
    "database lock is unavailable".into()
}

#[tauri::command]
pub fn get_bootstrap_status(state: State<'_, AppState>) -> Result<BootstrapStatus, String> {
    let database = state.database.lock().map_err(|_| lock_error())?;
    let document_count = database
        .query_row("SELECT COUNT(*) FROM documents", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let card_count = database
        .query_row("SELECT COUNT(*) FROM cards", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;

    Ok(BootstrapStatus {
        database_ready: true,
        schema_version: SCHEMA_VERSION,
        document_count,
        card_count,
    })
}

#[tauri::command]
pub fn create_card(
    state: State<'_, AppState>,
    input: CreateCardInput,
) -> Result<Card, String> {
    if input.excerpt.trim().is_empty()
        && input.user_note.trim().is_empty()
        && input.question.trim().is_empty()
    {
        return Err("a card needs an excerpt, note, or question".into());
    }
    if input.annotation.is_some() && input.source_ref.is_none() {
        return Err("an annotation requires a PDF source_ref".into());
    }
    if let Some(annotation) = &input.annotation {
        if !["highlight", "underline", "text", "rectangle"].contains(&annotation.kind.as_str()) {
            return Err("unsupported annotation kind".into());
        }
    }

    let (document_id, page, bbox) = match input.source_ref {
        Some(source) => {
            source.bbox.validate()?;
            if source.page == 0 {
                return Err("page numbers are one-based".into());
            }
            (Some(source.document_id), Some(source.page), Some(source.bbox))
        }
        None => (None, None, None),
    };

    let id = Uuid::new_v4().to_string();
    let timestamp = now();
    let mut database = state.database.lock().map_err(|_| lock_error())?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;

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
                    serde_json::to_string(&annotation.geometry).map_err(|error| error.to_string())?,
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

    let query = format!("SELECT {CARD_COLUMNS} FROM cards WHERE id = ?1");
    let card = transaction
        .query_row(&query, params![id], card_from_row)
        .map_err(|error| error.to_string())?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(card)
}

#[tauri::command]
pub fn list_cards(state: State<'_, AppState>, limit: Option<u32>) -> Result<Vec<Card>, String> {
    let database = state.database.lock().map_err(|_| lock_error())?;
    let query = format!(
        "SELECT {CARD_COLUMNS} FROM cards ORDER BY created_at DESC LIMIT ?1"
    );
    let mut statement = database.prepare(&query).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![limit.unwrap_or(200).clamp(1, 500)], card_from_row)
        .map_err(|error| error.to_string())?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn remove_card_from_mindmap(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let timestamp = now();
    let mut database = state.database.lock().map_err(|_| lock_error())?;
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

#[tauri::command]
pub fn delete_card(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let database = state.database.lock().map_err(|_| lock_error())?;
    let affected = database
        .execute("DELETE FROM cards WHERE id = ?1", params![id])
        .map_err(|error| error.to_string())?;
    if affected == 0 {
        return Err("card not found".into());
    }
    Ok(())
}
