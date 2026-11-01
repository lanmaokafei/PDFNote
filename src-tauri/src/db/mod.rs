use rusqlite::Connection;
use std::{path::Path, time::Duration};

pub const SCHEMA_VERSION: u32 = 1;
const INIT_SQL: &str = include_str!("../../migrations/001_init.sql");

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
        SCHEMA_VERSION => Ok(()),
        0 => apply_migration(connection, INIT_SQL),
        newer => Err(format!(
            "数据库 schema 版本 {newer} 高于当前应用支持的版本 {SCHEMA_VERSION}"
        )),
    }
}

fn apply_migration(connection: &Connection, sql: &str) -> Result<(), String> {
    connection
        .execute_batch("BEGIN IMMEDIATE")
        .map_err(|error| error.to_string())?;
    let result = connection
        .execute_batch(sql)
        .and_then(|_| connection.execute(&format!("PRAGMA user_version = {SCHEMA_VERSION}"), []))
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
