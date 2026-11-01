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
    Ok(connection)
}

fn migrate(connection: &Connection) -> Result<(), String> {
    let version: u32 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;

    if version > SCHEMA_VERSION {
        return Err(format!(
            "database schema {version} is newer than supported schema {SCHEMA_VERSION}"
        ));
    }
    if version == 0 {
        connection
            .execute_batch(INIT_SQL)
            .map_err(|error| error.to_string())?;
        connection
            .pragma_update(None, "user_version", SCHEMA_VERSION)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migration_creates_card_axis_schema() {
        let connection = Connection::open_in_memory().unwrap();
        migrate(&connection).unwrap();

        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);

        let foreign_keys: i64 = connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(foreign_keys, 0, "tests must enable foreign keys via open()");
    }
}
