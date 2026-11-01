use rusqlite::Connection;
use std::{
    path::PathBuf,
    sync::{Mutex, MutexGuard},
};

pub struct AppState {
    pub database: Mutex<Connection>,
    #[allow(dead_code)]
    pub database_path: PathBuf,
    pub data_dir: PathBuf,
    pub backup_lock: Mutex<()>,
}

impl AppState {
    pub fn new(database: Connection, database_path: PathBuf, data_dir: PathBuf) -> Self {
        Self {
            database: Mutex::new(database),
            database_path,
            data_dir,
            backup_lock: Mutex::new(()),
        }
    }

    pub fn db(&self) -> Result<MutexGuard<'_, Connection>, String> {
        self.database.lock().map_err(|_| "数据库不可用".into())
    }
}

#[cfg(test)]
pub fn test_state() -> (PathBuf, AppState) {
    use uuid::Uuid;

    let data_dir = std::env::temp_dir().join(format!("pdfnote-test-{}", Uuid::new_v4()));
    for directory in ["pdfs", "backups", "tmp"] {
        std::fs::create_dir_all(data_dir.join(directory)).unwrap();
    }
    let database_path = data_dir.join("pdfnote.db");
    let connection = Connection::open(&database_path).unwrap();
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .unwrap();
    crate::db::migrate(&connection).unwrap();
    let state = AppState::new(connection, database_path, data_dir.clone());
    (data_dir, state)
}
