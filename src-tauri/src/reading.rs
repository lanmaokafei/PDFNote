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
    /// 目录骨架映射：{"canvasId":[{cardId,page,title,level}]}，由「按目录建骨架」写入。
    pub toc_json: String,
    pub updated_at: String,
}

const COLUMNS: &str = "document_id, pass, recall_note, toc_json, updated_at";

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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTocJsonInput {
    pub document_id: String,
    pub toc_json: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddReadingTimeInput {
    pub document_id: String,
    /// 本地日期 `YYYY-MM-DD`：由前端按用户时区算好，避免后端猜时区。
    pub day: String,
    pub seconds: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingStatsInput {
    pub day: String,
    pub year_start: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingBookStat {
    pub document_id: String,
    pub title: String,
    pub year_seconds: i64,
    pub today_seconds: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingStats {
    pub today_seconds: i64,
    pub year_seconds: i64,
    /// 今年有阅读记录的书，按时长从多到少。
    pub books: Vec<ReadingBookStat>,
}

fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ReadingState> {
    Ok(ReadingState {
        document_id: row.get(0)?,
        pass: row.get::<_, i64>(1)?.clamp(1, 2) as u32,
        recall_note: row.get(2)?,
        toc_json: row.get(3)?,
        updated_at: row.get(4)?,
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
        toc_json: String::new(),
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

fn validate_day(day: &str) -> Result<(), String> {
    let bytes = day.as_bytes();
    let shaped = bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes.iter().enumerate().all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit());
    if shaped {
        Ok(())
    } else {
        Err("day must be YYYY-MM-DD".into())
    }
}

/// 累加阅读时长：按「书 + 本地日期」一行；单次最多记 1 小时，防止异常计时值污染统计。
pub fn add_reading_time(
    state: &AppState,
    document_id: &str,
    day: &str,
    seconds: u32,
) -> Result<(), String> {
    validate_day(day)?;
    if seconds == 0 {
        return Ok(());
    }
    if seconds > 3600 {
        return Err("seconds per flush cannot exceed 3600".into());
    }
    let database = state.db()?;
    ensure_document(&database, document_id)?;
    let timestamp = now();
    database
        .execute(
            "INSERT INTO reading_daily (document_id, day, seconds, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(document_id, day) DO UPDATE SET
                seconds = seconds + excluded.seconds,
                updated_at = excluded.updated_at",
            params![document_id, day, seconds, timestamp],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// 某一天的阅读时长（跨书合计）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadingDay {
    pub day: String,
    pub seconds: i64,
}

/// 跨书阅读日历：区间内每天的合计秒数，供年度回顾画柱状图与算连续天数。
pub fn get_reading_days(
    state: &AppState,
    start_day: &str,
    end_day: &str,
) -> Result<Vec<ReadingDay>, String> {
    validate_day(start_day)?;
    validate_day(end_day)?;
    if start_day > end_day {
        return Err("start_day must not be after end_day".into());
    }
    let database = state.db()?;
    let mut statement = database
        .prepare(
            "SELECT day, SUM(seconds) FROM reading_daily
             WHERE day >= ?1 AND day <= ?2
             GROUP BY day
             HAVING SUM(seconds) > 0
             ORDER BY day",
        )
        .map_err(|error| error.to_string())?;
    let days = statement
        .query_map(params![start_day, end_day], |row| {
            Ok(ReadingDay {
                day: row.get(0)?,
                seconds: row.get(1)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(days)
}

/// 阅读目标与年度排行：今日总时长、今年总时长、今年每本书的时长。
pub fn get_reading_stats(state: &AppState, day: &str, year_start: &str) -> Result<ReadingStats, String> {
    validate_day(day)?;
    validate_day(year_start)?;
    let database = state.db()?;
    let today_seconds: i64 = database
        .query_row(
            "SELECT COALESCE(SUM(seconds), 0) FROM reading_daily WHERE day = ?1",
            params![day],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let year_seconds: i64 = database
        .query_row(
            "SELECT COALESCE(SUM(seconds), 0) FROM reading_daily WHERE day >= ?1 AND day <= ?2",
            params![year_start, day],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let mut statement = database
        .prepare(
            "SELECT r.document_id, d.title,
                    SUM(r.seconds) AS year_seconds,
                    SUM(CASE WHEN r.day = ?2 THEN r.seconds ELSE 0 END) AS today_seconds
             FROM reading_daily r JOIN documents d ON d.id = r.document_id
             WHERE r.day >= ?1 AND r.day <= ?2
               AND NOT EXISTS (SELECT 1 FROM document_trash t WHERE t.document_id = r.document_id)
             GROUP BY r.document_id, d.title
             HAVING year_seconds > 0
             ORDER BY year_seconds DESC, d.title
             LIMIT 50",
        )
        .map_err(|error| error.to_string())?;
    let books = statement
        .query_map(params![year_start, day], |row| {
            Ok(ReadingBookStat {
                document_id: row.get(0)?,
                title: row.get(1)?,
                year_seconds: row.get(2)?,
                today_seconds: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(ReadingStats { today_seconds, year_seconds, books })
}

/** 目录骨架映射：一本书一份 JSON（按画布分组），只做「最近小节」查询，不进 cards 表。 */
pub fn save_toc_json(state: &AppState, document_id: &str, toc_json: &str) -> Result<ReadingState, String> {
    if toc_json.chars().count() > 200_000 {
        return Err("toc map is too large".into());
    }
    let database = state.db()?;
    ensure_document(&database, document_id)?;
    let timestamp = now();
    database
        .execute(
            "INSERT INTO document_readings (document_id, pass, recall_note, toc_json, created_at, updated_at)
             VALUES (?1, 1, '', ?2, ?3, ?3)
             ON CONFLICT(document_id) DO UPDATE SET toc_json = excluded.toc_json, updated_at = excluded.updated_at",
            params![document_id, toc_json.trim(), timestamp],
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
    fn toc_map_is_persisted_without_touching_stage_or_note() {
        let state = state();
        seed_document(&state, "doc1");
        set_reading_pass(&state, "doc1", 2).unwrap();
        save_recall_note(&state, "doc1", "三句话").unwrap();
        let saved = save_toc_json(&state, "doc1", r#"{"canvas-1":[{"cardId":"c1","page":3}]}"#).unwrap();
        assert_eq!(saved.pass, 2, "写目录不应该改阶段");
        assert_eq!(saved.recall_note, "三句话", "写目录不应该清空笔记");
        assert!(saved.toc_json.contains("canvas-1"));
        assert!(save_toc_json(&state, "doc1", &"x".repeat(200_001)).is_err());
    }

    #[test]
    fn reading_time_accumulates_and_ranks_books() {
        let state = state();
        seed_document(&state, "doc1");
        {
            // seed_document 的 content_hash 固定，第二本书要换一个哈希。
            let database = state.db().unwrap();
            database
                .execute(
                    "INSERT INTO documents (id, title, stored_path, content_hash, created_at, updated_at)
                     VALUES ('doc2', '第二本', 'pdfs/b.pdf', 'hash-2', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                    [],
                )
                .unwrap();
        }
        add_reading_time(&state, "doc1", "2026-11-16", 300).unwrap();
        add_reading_time(&state, "doc1", "2026-11-16", 120).unwrap();
        add_reading_time(&state, "doc2", "2026-11-16", 60).unwrap();
        add_reading_time(&state, "doc2", "2026-11-15", 900).unwrap();

        let stats = get_reading_stats(&state, "2026-11-16", "2026-01-01").unwrap();
        assert_eq!(stats.today_seconds, 480, "同一天多次累加");
        assert_eq!(stats.year_seconds, 1380, "今年累计含昨天");
        assert_eq!(stats.books.len(), 2);
        assert_eq!(stats.books[0].document_id, "doc2", "按时长从多到少");
        assert_eq!(stats.books[0].year_seconds, 960);
        assert_eq!(stats.books[1].today_seconds, 420);

        // 只统计今年：去年那笔不计入。
        let last_year = get_reading_stats(&state, "2027-01-01", "2027-01-01").unwrap();
        assert_eq!(last_year.today_seconds, 0);
        assert!(last_year.books.is_empty());

        // 参数校验：日期格式、单次上限。
        assert!(add_reading_time(&state, "doc1", "2026/11/16", 60).is_err());
        assert!(add_reading_time(&state, "doc1", "2026-11-16", 3601).is_err());
        assert!(get_reading_stats(&state, "bad", "2026-01-01").is_err());
        assert!(add_reading_time(&state, "missing", "2026-11-16", 60).is_err());
    }

    #[test]
    fn reading_days_aggregates_per_day_and_validates_range() {
        let state = state();
        seed_document(&state, "doc1");
        {
            let database = state.db().unwrap();
            database
                .execute(
                    "INSERT INTO documents (id, title, stored_path, content_hash, created_at, updated_at)
                     VALUES ('doc2', '第二本', 'pdfs/b.pdf', 'hash-2', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                    [],
                )
                .unwrap();
        }
        add_reading_time(&state, "doc1", "2026-03-01", 600).unwrap();
        add_reading_time(&state, "doc2", "2026-03-01", 300).unwrap();
        add_reading_time(&state, "doc1", "2026-03-03", 120).unwrap();

        let days = get_reading_days(&state, "2026-01-01", "2026-12-31").unwrap();
        assert_eq!(days.len(), 2, "同一天跨书要合并成一行");
        assert_eq!(days[0], ReadingDay { day: "2026-03-01".into(), seconds: 900 });
        assert_eq!(days[1].seconds, 120);

        assert!(get_reading_days(&state, "2026-12-31", "2026-01-01").is_err());
        assert!(get_reading_days(&state, "2026/01/01", "2026-12-31").is_err());
        assert!(get_reading_days(&state, "2020-01-01", "2020-12-31").unwrap().is_empty());
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
