use crate::{models, state::AppState};
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

/// A cached whole-page OCR result. `lines_json` is the serialized line array
/// produced by `ocr::recognize_lines`; it is derived data and can always be
/// regenerated, so it never participates in card semantics or backup merges of
/// card content.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageOcrRecord {
    pub document_id: String,
    pub page: i64,
    pub lines_json: String,
    pub engine: String,
    pub created_at: String,
}

pub fn get(state: &AppState, document_id: &str, page: i64) -> Result<Option<PageOcrRecord>, String> {
    let database = state.db()?;
    database
        .query_row(
            "SELECT document_id, page, lines_json, engine, created_at
             FROM page_ocr WHERE document_id = ?1 AND page = ?2",
            params![document_id, page],
            |row| {
                Ok(PageOcrRecord {
                    document_id: row.get(0)?,
                    page: row.get(1)?,
                    lines_json: row.get(2)?,
                    engine: row.get(3)?,
                    created_at: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())
}

pub fn save(
    state: &AppState,
    document_id: &str,
    page: i64,
    lines_json: &str,
    engine: &str,
) -> Result<(), String> {
    let database = state.db()?;
    database
        .execute(
            "INSERT INTO page_ocr (document_id, page, lines_json, engine, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(document_id, page) DO UPDATE SET
               lines_json = excluded.lines_json,
               engine = excluded.engine,
               created_at = excluded.created_at",
            params![document_id, page, lines_json, engine, models::now()],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::test_state;

    #[test]
    fn page_ocr_cache_round_trip_and_overwrite() {
        let (_directory, state) = test_state();
        assert!(get(&state, "doc-1", 7).unwrap().is_none());
        save(&state, "doc-1", 7, r#"[{"text":"信息熵"}]"#, "apple-vision").unwrap();
        let record = get(&state, "doc-1", 7).unwrap().expect("cache must be saved");
        assert_eq!(record.lines_json, r#"[{"text":"信息熵"}]"#);
        assert_eq!(record.engine, "apple-vision");
        assert_eq!(record.page, 7);

        save(&state, "doc-1", 7, "[]", "apple-vision").unwrap();
        assert_eq!(get(&state, "doc-1", 7).unwrap().unwrap().lines_json, "[]");
        assert!(get(&state, "doc-1", 8).unwrap().is_none());
        assert!(get(&state, "doc-2", 7).unwrap().is_none());
    }
}
