use rusqlite::Connection;
use std::{path::Path, time::Duration};

pub const SCHEMA_VERSION: u32 = 9;
const INIT_SQL: &str = include_str!("../../migrations/001_init.sql");
const DOCUMENT_PROGRESS_SQL: &str = include_str!("../../migrations/002_document_progress.sql");
const COLLABORATION_SQL: &str = include_str!("../../migrations/003_collaboration.sql");
const EXCERPT_IMAGE_SQL: &str = include_str!("../../migrations/004_card_excerpt_image.sql");
const PAGE_TEXT_SQL: &str = include_str!("../../migrations/005_page_text.sql");
const TITLE_LINK_SQL: &str = include_str!("../../migrations/006_title_link.sql");
const PAGE_NOTES_SQL: &str = include_str!("../../migrations/007_page_notes.sql");
const BOOK_DIGEST_SQL: &str = include_str!("../../migrations/008_book_digest.sql");
const MINDMAP_CANVASES_SQL: &str = include_str!("../../migrations/009_mindmap_canvases.sql");

pub fn open(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .busy_timeout(Duration::from_millis(5_000))
        .map_err(|error| error.to_string())?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|error| error.to_string())?;
    connection
        .pragma_update(None, "journal_mode", "WAL")
        .map_err(|error| error.to_string())?;
    connection
        .pragma_update(None, "synchronous", "NORMAL")
        .map_err(|error| error.to_string())?;
    migrate(&connection)?;
    quick_check(&connection)?;
    Ok(connection)
}

pub fn quick_check(connection: &Connection) -> Result<(), String> {
    let result: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if result == "ok" {
        Ok(())
    } else {
        Err(format!("数据库完整性检查失败: {result}"))
    }
}

pub fn migrate(connection: &Connection) -> Result<(), String> {
    let version: u32 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if version > SCHEMA_VERSION {
        return Err(format!(
            "数据库 schema 版本 {version} 高于当前应用支持的版本 {SCHEMA_VERSION}"
        ));
    }
    let migrations: [(&str, u32); 9] = [
        (INIT_SQL, 1),
        (DOCUMENT_PROGRESS_SQL, 2),
        (COLLABORATION_SQL, 3),
        (EXCERPT_IMAGE_SQL, 4),
        (PAGE_TEXT_SQL, 5),
        (TITLE_LINK_SQL, 6),
        (PAGE_NOTES_SQL, 7),
        (BOOK_DIGEST_SQL, 8),
        (MINDMAP_CANVASES_SQL, 9),
    ];
    for (sql, target_version) in migrations {
        if target_version > version {
            apply_migration(connection, sql, target_version)?;
        }
    }
    Ok(())
}

fn apply_migration(connection: &Connection, sql: &str, target_version: u32) -> Result<(), String> {
    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| error.to_string())?;
    let result = connection
        .execute_batch(sql)
        .and_then(|_| connection.execute(&format!("PRAGMA user_version = {target_version}"), []))
        .map(|_| ());
    match result {
        Ok(()) => connection
            .execute_batch("COMMIT")
            .map_err(|error| error.to_string()),
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(error.to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn columns(connection: &Connection, table: &str) -> Vec<String> {
        let mut statement = connection
            .prepare(&format!("PRAGMA table_info({table})"))
            .unwrap();
        statement
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    #[test]
    fn migration_creates_current_schema() {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();

        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        assert!(columns(&connection, "documents").contains(&"last_page".to_string()));
        assert!(columns(&connection, "cards").contains(&"excerpt_image".to_string()));
        assert!(columns(&connection, "cards").contains(&"link_aliases".to_string()));
        for table in ["card_tags", "card_links", "page_inks", "page_notes", "page_ocr", "book_analysis", "book_outline", "mindmap_canvases"] {
            let count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(count, 1, "{table} 必须存在");
        }
        for field in ["elapsed_days", "scheduled_days", "learning_steps"] {
            assert!(columns(&connection, "cards").contains(&field.to_string()));
        }
        for field in [
            "scheduled_days",
            "learning_steps",
            "reps",
            "lapses",
            "new_state",
            "payload_json",
        ] {
            assert!(columns(&connection, "review_logs").contains(&field.to_string()));
        }
        quick_check(&connection).unwrap();
    }

    #[test]
    fn upgrades_v1_database_with_default_progress() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(INIT_SQL).unwrap();
        connection.execute("PRAGMA user_version = 1", []).unwrap();
        migrate(&connection).unwrap();

        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let last_page: i64 = connection
            .query_row(
                "INSERT INTO documents (id, title, stored_path, content_hash, created_at, updated_at)
                 VALUES ('legacy', '旧文档', 'pdfs/a.pdf', 'hash', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
                 RETURNING last_page",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(last_page, 1);
        quick_check(&connection).unwrap();
    }

    #[test]
    fn upgrades_v5_database_with_title_link_aliases() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(INIT_SQL).unwrap();
        connection.execute_batch(DOCUMENT_PROGRESS_SQL).unwrap();
        connection.execute_batch(COLLABORATION_SQL).unwrap();
        connection.execute_batch(EXCERPT_IMAGE_SQL).unwrap();
        connection.execute_batch(PAGE_TEXT_SQL).unwrap();
        connection.execute("PRAGMA user_version = 5", []).unwrap();
        connection
            .execute(
                "INSERT INTO cards (id, excerpt, user_note, question, due, review_state, created_at, updated_at)
                 VALUES ('legacy-card', '', '', '心肌梗死', '2026-01-01T00:00:00.000Z', 'new', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                [],
            )
            .unwrap();
        migrate(&connection).unwrap();

        let aliases: String = connection
            .query_row("SELECT link_aliases FROM cards WHERE id = 'legacy-card'", [], |row| row.get(0))
            .unwrap();
        assert_eq!(aliases, "", "旧卡片升级后别名为空字符串");
        quick_check(&connection).unwrap();
    }

    #[test]
    fn upgrades_v6_database_with_page_notes() {
        let connection = Connection::open_in_memory().unwrap();
        for sql in [
            INIT_SQL,
            DOCUMENT_PROGRESS_SQL,
            COLLABORATION_SQL,
            EXCERPT_IMAGE_SQL,
            PAGE_TEXT_SQL,
            TITLE_LINK_SQL,
        ] {
            connection.execute_batch(sql).unwrap();
        }
        connection.execute("PRAGMA user_version = 6", []).unwrap();
        connection
            .execute(
                "INSERT INTO documents (id, title, stored_path, content_hash, created_at, updated_at)
                 VALUES ('doc1', '旧文档', 'pdfs/a.pdf', 'hash', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                [],
            )
            .unwrap();
        migrate(&connection).unwrap();

        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        connection
            .execute(
                "INSERT INTO page_notes (id, document_id, page, anchor_y, content, collapsed, color, created_at, updated_at)
                 VALUES ('n1', 'doc1', 1, 0.2, '页边草稿', 0, 'amber', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                [],
            )
            .unwrap();
        quick_check(&connection).unwrap();
    }

    #[test]
    fn open_enables_sqlite_safety_settings() {
        let directory =
            std::env::temp_dir().join(format!("pdfnote-dbtest-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).unwrap();
        let connection = open(&directory.join("pdfnote.db")).unwrap();
        let foreign_keys: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(foreign_keys, 1);
        assert_eq!(journal_mode, "wal");
        let _ = std::fs::remove_dir_all(&directory);
    }
}
