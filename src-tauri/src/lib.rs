mod commands;
mod db;
mod models;
mod state;

use state::AppState;
use std::{fs, io};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::get_bootstrap_status,
            commands::create_card,
            commands::list_cards,
            commands::remove_card_from_mindmap,
            commands::delete_card
        ])
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            for directory in ["pdfs", "backups", "tmp"] {
                fs::create_dir_all(data_dir.join(directory))?;
            }

            let database_path = data_dir.join("pdfnote.db");
            let database = db::open(&database_path)
                .map_err(|error| io::Error::new(io::ErrorKind::Other, error))?;
            app.manage(AppState::new(database, database_path));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running PDFNote");
}
