use crate::{backup, cards, documents, models, review, state::AppState};
use tauri::{ipc::Response, State};

#[tauri::command(async)]
pub fn ocr_image(image_data: String) -> Result<String, String> {
    crate::ocr::recognize_image(image_data)
}

#[tauri::command]
pub fn get_bootstrap_status(state: State<'_, AppState>) -> Result<models::BootstrapStatus, String> {
    let database = state.db()?;
    let document_count = database
        .query_row("SELECT COUNT(*) FROM documents", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let card_count = database
        .query_row("SELECT COUNT(*) FROM cards", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    Ok(models::BootstrapStatus {
        database_ready: true,
        schema_version: crate::db::SCHEMA_VERSION,
        document_count,
        card_count,
    })
}

#[tauri::command]
pub fn create_card(
    state: State<'_, AppState>,
    input: models::CreateCardInput,
) -> Result<models::Card, String> {
    cards::create_card(&state, input)
}

#[tauri::command]
pub fn list_cards(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<models::Card>, String> {
    cards::list_cards(&state, limit)
}

#[tauri::command]
pub fn list_due_cards(
    state: State<'_, AppState>,
    now: String,
    limit: Option<u32>,
) -> Result<Vec<models::Card>, String> {
    review::list_due_cards(&state, now, limit)
}

#[tauri::command]
pub fn update_card_content(
    state: State<'_, AppState>,
    input: models::UpdateCardContentInput,
) -> Result<models::Card, String> {
    cards::update_card_content(&state, input)
}

#[tauri::command]
pub fn remove_card_from_mindmap(state: State<'_, AppState>, id: String) -> Result<(), String> {
    cards::remove_card_from_mindmap(&state, id)
}

#[tauri::command]
pub fn delete_card(state: State<'_, AppState>, id: String) -> Result<(), String> {
    cards::delete_card(&state, id)
}

#[tauri::command]
pub fn list_annotations(
    state: State<'_, AppState>,
    document_id: String,
    pages: Vec<i64>,
) -> Result<Vec<models::Annotation>, String> {
    cards::list_annotations(&state, document_id, pages)
}

#[tauri::command]
pub fn update_annotation_geometry(
    state: State<'_, AppState>,
    id: String,
    geometry: models::AnnotationGeometry,
    bbox: models::NormalizedBBox,
) -> Result<(), String> {
    cards::update_annotation_geometry(&state, id, geometry, bbox)
}

#[tauri::command]
pub fn remove_annotation(
    state: State<'_, AppState>,
    id: String,
    delete_card: bool,
) -> Result<(), String> {
    cards::remove_annotation(&state, id, delete_card)
}

#[tauri::command]
pub fn list_mindmap_layout(
    state: State<'_, AppState>,
    canvas_id: Option<String>,
) -> Result<Vec<models::MindmapLayout>, String> {
    cards::list_mindmap_layout(&state, canvas_id)
}

#[tauri::command]
pub fn save_mindmap_layout(
    state: State<'_, AppState>,
    layouts: Vec<models::MindmapLayoutInput>,
) -> Result<(), String> {
    cards::save_mindmap_layout(&state, layouts)
}

#[tauri::command]
pub fn move_card(
    state: State<'_, AppState>,
    id: String,
    parent_id: Option<String>,
    sort_order: i64,
) -> Result<models::Card, String> {
    cards::move_card(&state, id, parent_id, sort_order)
}

#[tauri::command]
pub fn set_card_collapsed(
    state: State<'_, AppState>,
    id: String,
    collapsed: bool,
) -> Result<models::Card, String> {
    cards::set_card_collapsed(&state, id, collapsed)
}

#[tauri::command]
pub fn record_review(
    state: State<'_, AppState>,
    input: models::ReviewInput,
) -> Result<models::Card, String> {
    review::record_review(&state, input)
}

#[tauri::command]
pub fn get_review_stats(
    state: State<'_, AppState>,
    day_start: String,
) -> Result<models::ReviewStats, String> {
    review::get_review_stats(&state, day_start)
}

#[tauri::command(async)]
pub fn import_document(
    state: State<'_, AppState>,
    source_path: String,
) -> Result<models::Document, String> {
    documents::import_document(&state, source_path)
}

#[tauri::command]
pub fn list_documents(state: State<'_, AppState>) -> Result<Vec<models::Document>, String> {
    documents::list_documents(&state)
}

#[tauri::command(async)]
pub fn read_pdf_chunk(
    state: State<'_, AppState>,
    id: String,
    begin: u64,
    end: u64,
) -> Result<Response, String> {
    documents::read_pdf_chunk(&state, id, begin, end).map(Response::new)
}

#[tauri::command]
pub fn resolve_document_path(state: State<'_, AppState>, id: String) -> Result<String, String> {
    documents::resolve_document_path(&state, id)
}

#[tauri::command]
pub fn update_document_metadata(
    state: State<'_, AppState>,
    id: String,
    title: String,
    page_count: i64,
) -> Result<(), String> {
    documents::update_document_metadata(&state, id, title, page_count)
}

#[tauri::command(async)]
pub fn verify_document(state: State<'_, AppState>, id: String) -> Result<models::Document, String> {
    documents::verify_document(&state, id)
}

#[tauri::command(async)]
pub fn relocate_document(
    state: State<'_, AppState>,
    id: String,
    source_path: String,
) -> Result<models::Document, String> {
    documents::relocate_document(&state, id, source_path)
}

#[tauri::command(async)]
pub fn delete_document(
    state: State<'_, AppState>,
    id: String,
    keep_cards: bool,
) -> Result<(), String> {
    documents::delete_document(&state, id, keep_cards)
}

#[tauri::command(async)]
pub fn export_backup(
    state: State<'_, AppState>,
    destination_path: String,
) -> Result<models::BackupResult, String> {
    backup::export_backup(&state, destination_path)
}

#[tauri::command(async)]
pub fn import_backup(
    state: State<'_, AppState>,
    source_path: String,
    mode: String,
) -> Result<models::BackupResult, String> {
    backup::import_backup(&state, source_path, mode)
}

#[tauri::command(async)]
pub fn auto_backup(state: State<'_, AppState>) -> Result<String, String> {
    backup::auto_backup(&state)
}
