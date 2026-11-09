mod ai;
mod anki;
mod backup;
mod book;
mod canvas_layers;
mod canvases;
mod cards;
mod commands;
mod db;
mod documents;
mod models;
mod notebooks;
mod notes;
mod ocr;
mod page_text;
mod review;
mod state;
mod update;

use state::AppState;
use std::{fs, io};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::ocr_image,
            commands::ocr_page_lines,
            commands::get_ai_settings,
            commands::save_ai_settings,
            commands::test_ai_connection,
            commands::recognize_selection,
            commands::fetch_task_result,
            commands::list_page_notes,
            commands::create_page_note,
            commands::update_page_note,
            commands::delete_page_note,
            commands::explain_card,
            commands::analyze_book_chunk,
            commands::list_book_notes,
            commands::synthesize_book,
            commands::apply_book_outline,
            commands::clear_book_analysis,
            commands::get_page_ocr,
            commands::save_page_ocr,
            commands::get_bootstrap_status,
            commands::create_card,
            commands::list_cards,
            commands::list_due_cards,
            commands::update_card_content,
            commands::remove_card_from_mindmap,
            commands::delete_card,
            commands::clear_mindmap_cards,
            commands::list_mindmap_canvases,
            commands::create_mindmap_canvas,
            commands::rename_mindmap_canvas,
            commands::delete_mindmap_canvas,
            commands::preview_anki_txt,
            commands::import_anki_txt,
            commands::list_annotations,
            commands::update_annotation_geometry,
            commands::remove_annotation,
            commands::list_mindmap_layout,
            commands::save_mindmap_layout,
            commands::move_card,
            commands::apply_card_order,
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
            commands::check_for_update,
            commands::get_app_version,
            commands::download_update,
            commands::open_update_installer,
            commands::quit_app,
            commands::list_notebooks,
            commands::create_notebook,
            commands::update_notebook,
            commands::delete_notebook,
            commands::list_layers,
            commands::create_layer,
            commands::update_layer,
            commands::delete_layer,
            commands::list_notebook_inks,
            commands::create_notebook_ink,
            commands::delete_notebook_ink,
            commands::list_canvas_inks,
            commands::create_canvas_ink,
            commands::delete_canvas_ink,
            commands::list_layer_members,
            commands::set_card_layer,
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
            // 更新完成后（新版本首次启动）删掉已安装版本的安装包，避免 updates/ 越积越大。
            update::cleanup_installed_packages(&data_dir);

            let database_path = data_dir.join("pdfnote.db");
            let database = db::open(&database_path)
                .map_err(|error| io::Error::new(io::ErrorKind::Other, error))?;
            app.manage(AppState::new(database, database_path, data_dir));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running PDFNote");
}
