use rusqlite::Connection;
use std::{path::PathBuf, sync::Mutex};

pub struct AppState {
    pub database: Mutex<Connection>,
    #[allow(dead_code)]
    pub database_path: PathBuf,
}

impl AppState {
    pub fn new(database: Connection, database_path: PathBuf) -> Self {
        Self {
            database: Mutex::new(database),
            database_path,
        }
    }
}
