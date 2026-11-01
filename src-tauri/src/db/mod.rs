use rusqlite::Connection;
use std::{path::Path, time::Duration};

pub const SCHEMA_VERSION: u32 = 2;
const INIT_SQL: &str = include_str!("../../migrations/001_init.sql");
const DOCUMENT_PROGRESS_SQL: &str = include_str!("../../migrations/002_document_progress.sql");

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
    match version {
        version if version == SCHEMA_VERSION => Ok(()),
        0 => {
            apply_migration(connection, INIT_SQL, 1)?;
            apply_migration(connection, DOCUMENT_PROGRESS_SQL, 2)
        }
        1 => apply_migration(connection, DOCUMENT_PROGRESS_SQL, 2),
        newer => Err(format!(
            "数据库 schema 版本 {newer} 高于当前应用支持的版本 {SCHEMA_VERSION}"
        )),
    }
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
        assert_eq!(version, 2);
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
