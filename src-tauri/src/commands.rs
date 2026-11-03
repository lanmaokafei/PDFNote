use crate::{ai, backup, cards, documents, models, review, state::AppState};
use tauri::{ipc::Response, State};

/// 可选的视觉模型设置。未配置时应用不发任何网络请求。
#[tauri::command]
pub fn get_ai_settings(state: State<'_, AppState>) -> Result<ai::AiSettings, String> {
    ai::load_settings(&state)
}

#[tauri::command]
pub fn save_ai_settings(
    state: State<'_, AppState>,
    settings: ai::AiSettings,
) -> Result<ai::AiSettings, String> {
    ai::save_settings(&state, settings)
}

/// 用当前输入框的配置探测模型服务是否可用（不落盘）。
#[tauri::command]
pub async fn test_ai_connection(settings: ai::AiSettings) -> Result<ai::AiTestResult, String> {
    ai::test_connection(settings).await
}

/// 识别选区内容（公式 / 表格 / 通用）。仅在用户配置模型后可用。
#[tauri::command]
pub async fn recognize_selection(
    state: State<'_, AppState>,
    image: String,
    mode: String,
) -> Result<String, String> {
    ai::recognize_selection(&state, image, mode).await
}

/// 按任务号取回异步识别结果（网关超时后任务仍在执行时使用）。
#[tauri::command]
pub async fn fetch_task_result(
    state: State<'_, AppState>,
    task_no: String,
) -> Result<String, String> {
    ai::fetch_task_result(&state, task_no).await
}

#[tauri::command(async)]
pub fn ocr_image(image_data: String) -> Result<String, String> {
    crate::ocr::recognize_image(image_data)
}

/// Whole-page recognition with per-line geometry, used to build a selectable
/// text layer over scanned pages. Runs on the async command pool because Vision
/// can take seconds on a dense page.
#[tauri::command(async)]
pub fn ocr_page_lines(image_data: String) -> Result<Vec<crate::ocr::OcrLinePayload>, String> {
    crate::ocr::recognize_lines(image_data)
}

#[tauri::command]
pub fn get_page_ocr(
    state: State<'_, AppState>,
    document_id: String,
    page: i64,
) -> Result<Option<crate::page_text::PageOcrRecord>, String> {
    crate::page_text::get(&state, &document_id, page)
}

#[tauri::command]
pub fn save_page_ocr(
    state: State<'_, AppState>,
    document_id: String,
    page: i64,
    lines_json: String,
    engine: String,
) -> Result<(), String> {
    crate::page_text::save(&state, &document_id, page, &lines_json, &engine)
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

/// 导出 Markdown 到用户通过保存对话框选择的路径。只接受 .md/.markdown，避免误写其他文件。
#[tauri::command(async)]
pub fn export_markdown(path: String, content: String) -> Result<(), String> {
    if content.trim().is_empty() {
        return Err("导出内容为空".into());
    }
    let target = std::path::PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err("导出路径为空".into());
    }
    let markdown_extension = target
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("md") || value.eq_ignore_ascii_case("markdown"))
        .unwrap_or(false);
    if !markdown_extension {
        return Err("导出文件必须使用 .md 扩展名".into());
    }
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建导出目录: {error}"))?;
        }
    }
    std::fs::write(&target, content).map_err(|error| format!("写入 Markdown 失败: {error}"))
}

#[tauri::command]
pub fn set_card_tags(
    state: State<'_, AppState>,
    card_id: String,
    tags: Vec<String>,
) -> Result<models::Card, String> {
    cards::set_card_tags(&state, card_id, tags)
}

#[tauri::command]
pub fn list_tags(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    cards::list_tags(&state)
}

#[tauri::command]
pub fn list_card_links(state: State<'_, AppState>) -> Result<Vec<models::CardLink>, String> {
    cards::list_card_links(&state)
}

#[tauri::command]
pub fn create_card_link(
    state: State<'_, AppState>,
    source_card_id: String,
    target_card_id: String,
) -> Result<models::CardLink, String> {
    cards::create_card_link(&state, source_card_id, target_card_id)
}

#[tauri::command]
pub fn delete_card_link(state: State<'_, AppState>, id: String) -> Result<(), String> {
    cards::delete_card_link(&state, id)
}

#[tauri::command]
pub fn list_page_inks(
    state: State<'_, AppState>,
    document_id: String,
    pages: Vec<i64>,
) -> Result<Vec<models::PageInk>, String> {
    cards::list_page_inks(&state, document_id, pages)
}

#[tauri::command]
pub fn create_page_ink(
    state: State<'_, AppState>,
    document_id: String,
    page: u32,
    bbox: models::NormalizedBBox,
    style: serde_json::Value,
) -> Result<models::PageInk, String> {
    cards::create_page_ink(&state, document_id, page, bbox, style)
}

#[tauri::command]
pub fn delete_page_ink(state: State<'_, AppState>, id: String) -> Result<(), String> {
    cards::delete_page_ink(&state, id)
}

#[tauri::command]
pub fn merge_cards(
    state: State<'_, AppState>,
    card_ids: Vec<String>,
) -> Result<models::Card, String> {
    cards::merge_cards(&state, card_ids)
}

#[tauri::command]
pub fn update_document_progress(
    state: State<'_, AppState>,
    id: String,
    last_page: i64,
) -> Result<i64, String> {
    documents::update_document_progress(&state, id, last_page)
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

/// 把前端渲染崩溃（错误消息 + React 组件栈）追加到本地日志，便于离线诊断。
#[tauri::command(async)]
pub fn append_crash_log(state: State<'_, AppState>, payload: String) -> Result<String, String> {
    let logs_dir = state.data_dir.join("logs");
    std::fs::create_dir_all(&logs_dir).map_err(|error| error.to_string())?;
    let timestamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let path = logs_dir.join(format!("crash-{timestamp}.log"));
    // 追加而非覆盖：同一秒内多次崩溃都要留痕。
    use std::io::Write as _;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|error| error.to_string())?;
    writeln!(file, "{payload}").map_err(|error| error.to_string())?;
    // 只保留最近 20 份崩溃日志，避免无限增长。
    let mut crashes: Vec<std::path::PathBuf> = std::fs::read_dir(&logs_dir)
        .map_err(|error| error.to_string())?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .map(|value| value.starts_with("crash-") && value.ends_with(".log"))
                .unwrap_or(false)
        })
        .collect();
    crashes.sort();
    while crashes.len() > 20 {
        let oldest = crashes.remove(0);
        let _ = std::fs::remove_file(oldest);
    }
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::export_markdown;

    #[test]
    fn export_markdown_writes_md_and_rejects_other_extensions() {
        let directory =
            std::env::temp_dir().join(format!("pdfnote-export-{}", uuid::Uuid::new_v4()));
        let target = directory.join("outline.md");
        export_markdown(
            target.to_string_lossy().into_owned(),
            "# 标题\n\n- 卡片\n".into(),
        )
        .unwrap();
        let written = std::fs::read_to_string(&target).unwrap();
        assert!(written.contains("# 标题"));
        assert!(written.contains("- 卡片"));

        let error = export_markdown(
            directory.join("outline.txt").to_string_lossy().into_owned(),
            "content".into(),
        )
        .unwrap_err();
        assert!(error.contains(".md"));

        let empty =
            export_markdown(target.to_string_lossy().into_owned(), "   ".into()).unwrap_err();
        assert!(empty.contains("为空"));
        let _ = std::fs::remove_dir_all(&directory);
    }
}
