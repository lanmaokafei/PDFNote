mod backup;
mod cards;
mod commands;
mod db;
mod documents;
mod models;
mod ocr;
mod review;
mod state;

use state::AppState;
use std::{fs, io};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::ocr_image,
            commands::get_bootstrap_status,
            commands::create_card,
            commands::list_cards,
            commands::list_due_cards,
            commands::update_card_content,
            commands::remove_card_from_mindmap,
            commands::delete_card,
            commands::list_annotations,
            commands::update_annotation_geometry,
            commands::remove_annotation,
            commands::list_mindmap_layout,
            commands::save_mindmap_layout,
            commands::move_card,
            commands::set_card_collapsed,
            commands::set_card_tags,
            commands::list_tags,
            commands::list_card_links,
            commands::create_card_link,
            commands::delete_card_link,
            commands::list_page_inks,
            commands::create_page_ink,
            commands::delete_page_ink,
            commands::merge_cards,
            commands::record_review,
            commands::get_review_stats,
            commands::import_document,
            commands::list_documents,
            commands::resolve_document_path,
            commands::read_pdf_chunk,
            commands::update_document_metadata,
            commands::update_document_progress,
            commands::export_markdown,
            commands::verify_document,
            commands::relocate_document,
            commands::delete_document,
            commands::export_backup,
            commands::import_backup,
            commands::auto_backup,
            commands::append_crash_log,
        ])
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            for directory in ["pdfs", "backups", "tmp"] {
                fs::create_dir_all(data_dir.join(directory))?;
            }
            if data_dir.join("tmp").read_dir().is_ok() {
                if let Ok(entries) = data_dir.join("tmp").read_dir() {
                    for entry in entries.filter_map(|entry| entry.ok()) {
                        let _ = fs::remove_file(entry.path());
                    }
                }
            }

            let database_path = data_dir.join("pdfnote.db");
            let database = db::open(&database_path)
                .map_err(|error| io::Error::new(io::ErrorKind::Other, error))?;
            app.manage(AppState::new(database, database_path, data_dir));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running PDFNote");
}
