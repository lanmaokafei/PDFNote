use crate::{models::now, state::AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

/// 每本书的「两遍阅读」状态。
///
/// - `pass`：1 = 第一遍找骨（只标关键词），2 = 第二遍填肉（建骨架、挂细节）
/// - `recall_note`：第一遍结束时写的「我记得的」自由召回
/// - `updated_at` 为空串表示还没写过行（按第一遍处理）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingState {
    pub document_id: String,
    pub pass: u32,
    pub recall_note: String,
    pub updated_at: String,
}

const COLUMNS: &str = "document_id, pass, recall_note, updated_at";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentRefInput {
    pub document_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetReadingPassInput {
    pub document_id: String,
    pub pass: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRecallNoteInput {
    pub document_id: String,
    pub note: String,
}

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReadingState> {
    Ok(ReadingState {
        document_id: row.get(0)?,
        pass: row.get::<_, i64>(1)?.clamp(1, 2) as u32,
        recall_note: row.get(2)?,
        updated_at: row.get(3)?,
    })
}

fn ensure_document(connection: &Connection, document_id: &str) -> Result<(), String> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM documents WHERE id = ?1)",
            params![document_id],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if exists {
        Ok(())
    } else {
        Err("document not found".into())
    }
}

fn read_row(connection: &Connection, document_id: &str) -> Result<Option<ReadingState>, String> {
    connection
        .query_row(
            &format!("SELECT {COLUMNS} FROM document_readings WHERE document_id = ?1"),
            params![document_id],
            from_row,
        )
        .optional()
        .map_err(|error| error.to_string())
}

/// 没有行时返回默认值（pass = 1），**不预写**，避免导入旧书时刷一桌空行。
pub fn get_reading_state(state: &AppState, document_id: &str) -> Result<ReadingState, String> {
    let database = state.db()?;
    if let Some(row) = read_row(&database, document_id)? {
        return Ok(row);
    }
    ensure_document(&database, document_id)?;
    Ok(ReadingState {
        document_id: document_id.to_string(),
        pass: 1,
        recall_note: String::new(),
        updated_at: String::new(),
    })
}

pub fn set_reading_pass(state: &AppState, document_id: &str, pass: u32) -> Result<ReadingState, String> {
    if !(1..=2).contains(&pass) {
        return Err("pass must be 1 or 2".into());
    }
    let database = state.db()?;
    ensure_document(&database, document_id)?;
    let timestamp = now();
    database
        .execute(
            "INSERT INTO document_readings (document_id, pass, recall_note, created_at, updated_at)
             VALUES (?1, ?2, '', ?3, ?3)
             ON CONFLICT(document_id) DO UPDATE SET pass = excluded.pass, updated_at = excluded.updated_at",
            params![document_id, pass, timestamp],
        )
        .map_err(|error| error.to_string())?;
    read_row(&database, document_id)?.ok_or_else(|| "reading state missing after write".into())
}

pub fn save_recall_note(state: &AppState, document_id: &str, note: &str) -> Result<ReadingState, String> {
    if note.chars().count() > 20_000 {
        return Err("recall note is too long".into());
    }
    let database = state.db()?;
    ensure_document(&database, document_id)?;
    let timestamp = now();
    database
        .execute(
            "INSERT INTO document_readings (document_id, pass, recall_note, created_at, updated_at)
             VALUES (?1, 1, ?2, ?3, ?3)
             ON CONFLICT(document_id) DO UPDATE SET recall_note = excluded.recall_note, updated_at = excluded.updated_at",
            params![document_id, note.trim(), timestamp],
        )
        .map_err(|error| error.to_string())?;
    read_row(&database, document_id)?.ok_or_else(|| "reading state missing after write".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn state() -> AppState {
        crate::state::test_state().1
    }

    fn seed_document(state: &AppState, id: &str) {
        {
            let database = state.db().unwrap();
            database
                .execute(
                    "INSERT INTO documents (id, title, stored_path, content_hash, created_at, updated_at)
                     VALUES (?1, '书', 'pdfs/a.pdf', 'hash', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                    params![id],
                )
                .unwrap();
        }
    }

    #[test]
    fn defaults_to_first_pass_without_writing_a_row() {
        let state = state();
        seed_document(&state, "doc1");
        let reading = get_reading_state(&state, "doc1").unwrap();
        assert_eq!(reading.pass, 1);
        assert_eq!(reading.recall_note, "");
        assert_eq!(reading.updated_at, "");
        let count: i64 = state
            .db()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM document_readings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0, "读默认值不应该写库");
    }

    #[test]
    fn rejects_unknown_document_and_bad_pass() {
        let state = state();
        assert!(get_reading_state(&state, "missing").is_err());
        seed_document(&state, "doc1");
        assert!(set_reading_pass(&state, "doc1", 3).is_err());
        assert!(set_reading_pass(&state, "doc1", 0).is_err());
    }

    #[test]
    fn pass_and_recall_note_are_persisted_independently() {
        let state = state();
        seed_document(&state, "doc1");
        let after_pass = set_reading_pass(&state, "doc1", 2).unwrap();
        assert_eq!(after_pass.pass, 2);
        assert_eq!(after_pass.recall_note, "");

        let after_note = save_recall_note(&state, "doc1", "  第一章讲了三个机制  ").unwrap();
        assert_eq!(after_note.recall_note, "第一章讲了三个机制");
        assert_eq!(after_note.pass, 2, "写召回不应该把阶段退回第一遍");

        let stored = get_reading_state(&state, "doc1").unwrap();
        assert_eq!(stored.pass, 2);
        assert_eq!(stored.recall_note, "第一章讲了三个机制");
    }

    #[test]
    fn deleting_document_cascades_reading_state() {
        let state = state();
        seed_document(&state, "doc1");
        set_reading_pass(&state, "doc1", 2).unwrap();
        {
            let database = state.db().unwrap();
            database.execute("DELETE FROM documents WHERE id = 'doc1'", []).unwrap();
        }
        let count: i64 = state
            .db()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM document_readings", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
        let _ = db::quick_check(&state.db().unwrap());
    }
}
