use crate::{
    ai, anki, backup, book, canvas_layers, canvases, cards, documents, models, notebooks, reading,
    review, state::AppState, update,
};
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

/// 用模型解析卡片问题，返回纯文本解释（由前端决定写回笔记）。
/// AI 出题返回的草稿：前端确认后再决定建不建卡。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionDraft {
    pub question: String,
    pub answer: String,
}

#[tauri::command]
pub async fn hint_card(state: State<'_, AppState>, card_id: String) -> Result<String, String> {
    ai::hint_card(&state, card_id).await
}

#[tauri::command]
pub async fn ask_card(
    state: State<'_, AppState>,
    card_id: String,
    question: String,
) -> Result<String, String> {
    ai::ask_card(&state, card_id, question).await
}

#[tauri::command]
pub async fn generate_card_questions(
    state: State<'_, AppState>,
    card_id: String,
    count: Option<u32>,
) -> Result<Vec<QuestionDraft>, String> {
    let items = ai::generate_questions(&state, card_id, count.unwrap_or(4)).await?;
    Ok(items
        .into_iter()
        .map(|(question, answer)| QuestionDraft { question, answer })
        .collect())
}

#[tauri::command]
pub async fn explain_card(state: State<'_, AppState>, card_id: String) -> Result<String, String> {
    ai::explain_card(&state, card_id).await
}

/// AI 拆书阶段一：分析一块文本并保存笔记。
#[tauri::command]
pub async fn analyze_book_chunk(
    state: State<'_, AppState>,
    input: book::DigestChunkInput,
) -> Result<book::ChunkNote, String> {
    book::analyze_chunk(&state, input).await
}

/// 已完成的拆书分块（中断后继续）。
#[tauri::command(async)]
pub fn list_book_notes(
    state: State<'_, AppState>,
    document_id: String,
    mode: String,
) -> Result<Vec<book::ChunkNote>, String> {
    book::list_notes(&state, document_id, mode)
}

/// AI 拆书阶段二：把分块笔记汇总成层级骨架，depth 由读者设置（缺省 2 层）。
#[tauri::command]
pub async fn synthesize_book(
    state: State<'_, AppState>,
    document_id: String,
    mode: String,
    depth: Option<u32>,
) -> Result<book::BookOutline, String> {
    book::synthesize(&state, document_id, mode, depth).await
}

/// 把骨架写入卡片与脑图（重复应用不会翻倍）。
#[tauri::command(async)]
pub fn apply_book_outline(
    state: State<'_, AppState>,
    document_id: String,
    mode: String,
    canvas_id: Option<String>,
) -> Result<u32, String> {
    book::apply_outline(&state, document_id, mode, canvas_id)
}

/// 清空某模式的拆书中间产物（已生成的卡片保留）。
#[tauri::command(async)]
pub fn clear_book_analysis(
    state: State<'_, AppState>,
    document_id: String,
    mode: String,
) -> Result<(), String> {
    book::clear(&state, document_id, mode)
}

/// 列出某文档的全部留白（页边草稿）。
#[tauri::command(async)]
pub fn list_page_notes(
    state: State<'_, AppState>,
    document_id: String,
) -> Result<Vec<models::PageNote>, String> {
    crate::notes::list_page_notes(&state, document_id)
}

#[tauri::command(async)]
pub fn create_page_note(
    state: State<'_, AppState>,
    input: models::CreatePageNoteInput,
) -> Result<models::PageNote, String> {
    crate::notes::create_page_note(&state, input)
}

#[tauri::command(async)]
pub fn update_page_note(
    state: State<'_, AppState>,
    input: models::UpdatePageNoteInput,
) -> Result<models::PageNote, String> {
    crate::notes::update_page_note(&state, input)
}

#[tauri::command(async)]
pub fn delete_page_note(state: State<'_, AppState>, id: String) -> Result<(), String> {
    crate::notes::delete_page_note(&state, id)
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
    card_ids: Option<Vec<String>>,
) -> Result<Vec<models::Card>, String> {
    review::list_due_cards(&state, now, limit, card_ids)
}

#[tauri::command]
pub fn update_card_content(
    state: State<'_, AppState>,
    input: models::UpdateCardContentInput,
) -> Result<models::Card, String> {
    cards::update_card_content(&state, input)
}

#[tauri::command]
pub fn remove_card_from_mindmap(
    state: State<'_, AppState>,
    id: String,
    canvas_id: Option<String>,
) -> Result<(), String> {
    cards::remove_card_from_mindmap(&state, id, canvas_id)
}

#[tauri::command]
pub fn delete_card(state: State<'_, AppState>, id: String) -> Result<(), String> {
    cards::delete_card(&state, id)
}

#[tauri::command]
pub fn list_trashed_cards(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<cards::TrashedCard>, String> {
    cards::list_trashed_cards(&state, limit)
}

#[tauri::command]
pub fn restore_card(state: State<'_, AppState>, id: String) -> Result<models::Card, String> {
    cards::restore_card(&state, id)
}

#[tauri::command]
pub fn purge_trashed_card(state: State<'_, AppState>, id: String) -> Result<(), String> {
    cards::purge_trashed_card(&state, id)
}

/// 清理过期回收站（默认 30 天），返回删除数量。
#[tauri::command(async)]
pub fn purge_expired_trash(state: State<'_, AppState>, days: Option<u32>) -> Result<u32, String> {
    cards::purge_expired_trash(&state, days.unwrap_or(30))
}

/// 批量清空指定画布的卡片：remove 仅移除该画布布局，delete 彻底删除卡片。
#[tauri::command(async)]
pub fn clear_mindmap_cards(
    state: State<'_, AppState>,
    mode: String,
    canvas_id: Option<String>,
) -> Result<u32, String> {
    cards::clear_mindmap_cards(&state, mode, canvas_id)
}

#[tauri::command]
pub fn list_mindmap_canvases(
    state: State<'_, AppState>,
    document_id: Option<String>,
) -> Result<Vec<models::MindmapCanvas>, String> {
    canvases::list_canvases(&state, document_id)
}

#[tauri::command]
pub fn create_mindmap_canvas(
    state: State<'_, AppState>,
    input: models::CreateMindmapCanvasInput,
) -> Result<models::MindmapCanvas, String> {
    canvases::create_canvas(&state, input)
}

#[tauri::command]
pub fn rename_mindmap_canvas(
    state: State<'_, AppState>,
    id: String,
    name: String,
) -> Result<models::MindmapCanvas, String> {
    canvases::rename_canvas(&state, id, name)
}

#[tauri::command]
pub fn delete_mindmap_canvas(
    state: State<'_, AppState>,
    id: String,
) -> Result<u32, String> {
    canvases::delete_canvas(&state, id)
}

#[tauri::command]
pub fn preview_anki_txt(source_path: String) -> Result<anki::AnkiPreview, String> {
    anki::preview_anki_txt(&source_path)
}

/// 大批量写库，放 async 线程避免阻塞 WebView。
#[tauri::command(async)]
pub fn import_anki_txt(
    state: State<'_, AppState>,
    input: anki::AnkiImportInput,
) -> Result<anki::AnkiImportResult, String> {
    anki::import_anki_txt(&state, input)
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
pub fn apply_card_order(
    state: State<'_, AppState>,
    updates: Vec<models::CardOrderUpdate>,
) -> Result<(), String> {
    cards::apply_card_order(&state, updates)
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
pub fn get_card_review_stats(
    state: State<'_, AppState>,
    since: String,
) -> Result<Vec<review::CardReviewStat>, String> {
    review::get_card_review_stats(&state, &since)
}

#[tauri::command]
pub fn get_review_stats(
    state: State<'_, AppState>,
    day_start: String,
) -> Result<models::ReviewStats, String> {
    review::get_review_stats(&state, day_start)
}

/// 撤销一次评分：恢复评分前的调度状态并删除那条日志。
#[tauri::command]
pub fn revert_review(state: State<'_, AppState>, client_event_id: String) -> Result<models::Card, String> {
    review::revert_review(&state, client_event_id)
}

#[tauri::command]
pub fn get_study_overview(
    state: State<'_, AppState>,
    since: String,
) -> Result<review::StudyOverview, String> {
    review::get_study_overview(&state, &since)
}

#[tauri::command(async)]
pub fn export_anki_txt(
    state: State<'_, AppState>,
    input: anki::AnkiExportInput,
) -> Result<u32, String> {
    anki::export_anki_txt(&state, input)
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

/// 导出 OPML 到用户选择的路径（MindManager / 幕布可直接导入做分层背诵）。
#[tauri::command(async)]
pub fn export_opml(path: String, content: String) -> Result<(), String> {
    if content.trim().is_empty() {
        return Err("导出内容为空".into());
    }
    let target = std::path::PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err("导出路径为空".into());
    }
    let opml_extension = target
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("opml"))
        .unwrap_or(false);
    if !opml_extension {
        return Err("导出文件必须使用 .opml 扩展名".into());
    }
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建导出目录: {error}"))?;
        }
    }
    std::fs::write(&target, content).map_err(|error| format!("写入 OPML 失败: {error}"))
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

/// 导出文件：单张图片直接写，多个文件自动打成 zip。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFile {
    pub name: String,
    /// PNG / JPEG 的 base64（不含 data: 前缀）。
    pub base64: String,
}

fn decode_base64(input: &str, name: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(input.trim())
        .map_err(|error| format!("{name} 不是有效的 base64：{error}"))
}

fn safe_file_name(name: &str, index: usize) -> String {
    let base = std::path::Path::new(name)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|ch| if ch.is_alphanumeric() || ch == '.' || ch == '-' || ch == '_' || ch == ' ' { ch } else { '_' })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.');
    if trimmed.is_empty() {
        format!("image-{}.png", index + 1)
    } else {
        trimmed.to_string()
    }
}

/// 把前端渲染好的图片写盘；多个文件时 destination 必须是 .zip。
#[tauri::command]
pub fn save_export_files(
    destination: String,
    files: Vec<ExportFile>,
) -> Result<String, String> {
    use std::io::Write;
    if files.is_empty() {
        return Err("没有可导出的内容".into());
    }
    let target = std::path::PathBuf::from(&destination);
    if !target.is_absolute() {
        return Err("导出路径必须是绝对路径".into());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| format!("无法创建目录：{error}"))?;
    }
    let is_zip = target
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("zip"))
        .unwrap_or(false);

    if !is_zip {
        if files.len() != 1 {
            return Err("多个文件必须保存为 .zip".into());
        }
        let bytes = decode_base64(&files[0].base64, &files[0].name)?;
        std::fs::write(&target, bytes).map_err(|error| format!("写入失败：{error}"))?;
        return Ok(target.to_string_lossy().to_string());
    }

    let output = std::fs::File::create(&target).map_err(|error| format!("无法创建压缩包：{error}"))?;
    let mut zip = zip::ZipWriter::new(output);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    let mut used: Vec<String> = Vec::new();
    for (index, file) in files.iter().enumerate() {
        let mut name = safe_file_name(&file.name, index);
        if used.contains(&name) {
            let stem = std::path::Path::new(&name).file_stem().and_then(|value| value.to_str()).unwrap_or("image").to_string();
            let ext = std::path::Path::new(&name).extension().and_then(|value| value.to_str()).unwrap_or("png").to_string();
            name = format!("{stem}-{}.{ext}", index + 1);
        }
        used.push(name.clone());
        let bytes = decode_base64(&file.base64, &file.name)?;
        zip.start_file(name, options).map_err(|error| format!("写入压缩包失败：{error}"))?;
        zip.write_all(&bytes).map_err(|error| format!("写入压缩包失败：{error}"))?;
    }
    zip.finish().map_err(|error| format!("压缩包收尾失败：{error}"))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn list_tag_stats(state: State<'_, AppState>) -> Result<Vec<cards::TagStat>, String> {
    cards::list_tag_stats(&state)
}

#[tauri::command]
pub fn rename_tag(state: State<'_, AppState>, from: String, to: String) -> Result<u32, String> {
    cards::rename_tag(&state, from, to)
}

#[tauri::command]
pub fn delete_tag(state: State<'_, AppState>, tag: String) -> Result<u32, String> {
    cards::delete_tag(&state, tag)
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

#[tauri::command]
pub fn rename_document(
    state: State<'_, AppState>,
    id: String,
    title: String,
) -> Result<models::Document, String> {
    documents::rename_document(&state, id, title)
}

#[tauri::command]
pub fn trash_document(state: State<'_, AppState>, id: String) -> Result<(), String> {
    documents::trash_document(&state, id)
}

#[tauri::command]
pub fn list_trashed_documents(
    state: State<'_, AppState>,
    limit: Option<u32>,
) -> Result<Vec<documents::TrashedDocument>, String> {
    documents::list_trashed_documents(&state, limit)
}

#[tauri::command]
pub fn restore_document(state: State<'_, AppState>, id: String) -> Result<models::Document, String> {
    documents::restore_document(&state, id)
}

#[tauri::command]
pub fn purge_document(state: State<'_, AppState>, id: String) -> Result<(), String> {
    documents::purge_document(&state, id)
}

/// 清理过期文档回收站（默认 30 天），返回删除数量。
#[tauri::command(async)]
pub fn purge_expired_document_trash(
    state: State<'_, AppState>,
    days: Option<u32>,
) -> Result<u32, String> {
    documents::purge_expired_document_trash(&state, days.unwrap_or(30))
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

/// 检查 GitHub Releases 是否有新版本（启动后自动调用 + 设置里手动调用）。
#[tauri::command]
pub async fn check_for_update() -> Result<update::UpdateInfo, String> {
    update::check_for_update().await
}

/// 当前应用版本号（设置页展示用，不联网）。
#[tauri::command(async)]
pub fn get_app_version() -> String {
    update::current_version().to_string()
}

/// 下载更新安装包，过程通过 `update-download-progress` 事件报告进度，
/// 完成后校验 SHA-256 再落盘，返回本地 DMG 路径。
#[tauri::command]
pub async fn download_update(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    info: update::UpdateInfo,
) -> Result<String, String> {
    update::download_update(&app, &state, &info).await
}

/// 打开已下载并校验过的 DMG 安装器（挂载后由用户拖入 Applications）。
#[tauri::command(async)]
pub fn open_update_installer(path: String) -> Result<(), String> {
    update::open_installer(&path)
}

/// 打开安装器后退出应用：运行中的 PDFNote.app 会让 Finder 判定「正在使用中」，
/// 拖进 Applications 覆盖安装会失败。前端先提示再调用这里。
#[tauri::command(async)]
pub fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn list_notebooks(state: State<'_, AppState>) -> Result<Vec<models::Notebook>, String> {
    notebooks::list_notebooks(&state)
}

#[tauri::command]
pub fn create_notebook(
    state: State<'_, AppState>,
    input: models::CreateNotebookInput,
) -> Result<models::Notebook, String> {
    notebooks::create_notebook(&state, input)
}

#[tauri::command]
pub fn update_notebook(
    state: State<'_, AppState>,
    input: models::UpdateNotebookInput,
) -> Result<models::Notebook, String> {
    notebooks::update_notebook(&state, input)
}

#[tauri::command]
pub fn delete_notebook(state: State<'_, AppState>, id: String) -> Result<(), String> {
    notebooks::delete_notebook(&state, id)
}

#[tauri::command]
pub fn list_layers(
    state: State<'_, AppState>,
    scope: String,
    owner_id: String,
) -> Result<Vec<models::Layer>, String> {
    notebooks::list_layers(&state, scope, owner_id)
}

#[tauri::command]
pub fn create_layer(
    state: State<'_, AppState>,
    input: models::CreateLayerInput,
) -> Result<models::Layer, String> {
    notebooks::create_layer(&state, input)
}

#[tauri::command]
pub fn update_layer(
    state: State<'_, AppState>,
    input: models::UpdateLayerInput,
) -> Result<models::Layer, String> {
    notebooks::update_layer(&state, input)
}

#[tauri::command]
pub fn delete_layer(state: State<'_, AppState>, id: String) -> Result<(), String> {
    notebooks::delete_layer(&state, id)
}

#[tauri::command]
pub fn list_notebook_inks(
    state: State<'_, AppState>,
    notebook_id: String,
) -> Result<Vec<models::NotebookInk>, String> {
    notebooks::list_notebook_inks(&state, notebook_id)
}

#[tauri::command]
pub fn create_notebook_ink(
    state: State<'_, AppState>,
    input: models::CreateNotebookInkInput,
) -> Result<models::NotebookInk, String> {
    notebooks::create_notebook_ink(&state, input)
}

#[tauri::command]
pub fn delete_notebook_ink(state: State<'_, AppState>, id: String) -> Result<(), String> {
    notebooks::delete_notebook_ink(&state, id)
}

#[tauri::command]
pub fn list_canvas_inks(
    state: State<'_, AppState>,
    canvas_id: String,
) -> Result<Vec<models::CanvasInk>, String> {
    canvas_layers::list_canvas_inks(&state, canvas_id)
}

#[tauri::command]
pub fn create_canvas_ink(
    state: State<'_, AppState>,
    input: models::CreateCanvasInkInput,
) -> Result<models::CanvasInk, String> {
    canvas_layers::create_canvas_ink(&state, input)
}

#[tauri::command]
pub fn delete_canvas_ink(state: State<'_, AppState>, id: String) -> Result<(), String> {
    canvas_layers::delete_canvas_ink(&state, id)
}

#[tauri::command]
pub fn list_layer_members(
    state: State<'_, AppState>,
    canvas_id: String,
) -> Result<Vec<models::LayerMember>, String> {
    canvas_layers::list_layer_members(&state, canvas_id)
}

#[tauri::command]
pub fn set_card_layer(
    state: State<'_, AppState>,
    input: models::SetCardLayerInput,
) -> Result<(), String> {
    canvas_layers::set_card_layer(&state, input)
}

#[cfg(test)]
mod tests {
    use super::{export_markdown, save_export_files, ExportFile};

    fn png_base64() -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode([0x89, b'P', b'N', b'G', 1, 2, 3])
    }

    #[test]
    fn save_export_writes_single_png_and_rejects_multi_without_zip() {
        let directory = std::env::temp_dir().join(format!("pdfnote-export-{}", uuid::Uuid::new_v4()));
        let target = directory.join("page-1.png");
        save_export_files(
            target.to_string_lossy().to_string(),
            vec![ExportFile { name: "第 1 页.png".into(), base64: png_base64() }],
        )
        .unwrap();
        let bytes = std::fs::read(&target).unwrap();
        assert_eq!(bytes.len(), 7);

        let error = save_export_files(
            directory.join("two.png").to_string_lossy().to_string(),
            vec![
                ExportFile { name: "a.png".into(), base64: png_base64() },
                ExportFile { name: "b.png".into(), base64: png_base64() },
            ],
        )
        .unwrap_err();
        assert!(error.contains("zip"), "多文件应提示 zip：{error}");

        assert!(save_export_files(
            "relative/out.png".into(),
            vec![ExportFile { name: "a.png".into(), base64: png_base64() }]
        )
        .is_err());
        assert!(save_export_files(
            target.to_string_lossy().to_string(),
            vec![ExportFile { name: "坏.png".into(), base64: "不是base64".into() }]
        )
        .is_err());
    }

    #[test]
    fn save_export_zips_multiple_images_with_safe_names() {
        let directory = std::env::temp_dir().join(format!("pdfnote-export-{}", uuid::Uuid::new_v4()));
        let target = directory.join("notebook.zip");
        save_export_files(
            target.to_string_lossy().to_string(),
            vec![
                ExportFile { name: "第 1 页.png".into(), base64: png_base64() },
                ExportFile { name: "../第 2 页.png".into(), base64: png_base64() },
                ExportFile { name: "第 2 页.png".into(), base64: png_base64() },
            ],
        )
        .unwrap();
        let file = std::fs::File::open(&target).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        assert_eq!(zip.len(), 3);
        let names: Vec<String> = (0..zip.len())
            .map(|index| zip.by_index(index).unwrap().name().to_string())
            .collect();
        assert!(names.iter().all(|name| !name.contains("..")), "不能出现路径穿越：{names:?}");
        assert!(names.iter().any(|name| name.contains("第 1 页")), "{names:?}");
        assert_eq!(names.len(), 3, "重名要自动加序号：{names:?}");
    }

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

#[tauri::command]
pub fn get_reading_state(
    state: State<'_, AppState>,
    input: reading::DocumentRefInput,
) -> Result<reading::ReadingState, String> {
    reading::get_reading_state(&state, &input.document_id)
}

#[tauri::command]
pub fn set_reading_pass(
    state: State<'_, AppState>,
    input: reading::SetReadingPassInput,
) -> Result<reading::ReadingState, String> {
    reading::set_reading_pass(&state, &input.document_id, input.pass)
}

#[tauri::command]
pub fn save_toc_json(
    state: State<'_, AppState>,
    input: reading::SaveTocJsonInput,
) -> Result<reading::ReadingState, String> {
    reading::save_toc_json(&state, &input.document_id, &input.toc_json)
}

#[tauri::command]
pub fn add_reading_time(
    state: State<'_, AppState>,
    input: reading::AddReadingTimeInput,
) -> Result<(), String> {
    reading::add_reading_time(&state, &input.document_id, &input.day, input.seconds)
}

#[tauri::command]
pub fn get_reading_stats(
    state: State<'_, AppState>,
    input: reading::ReadingStatsInput,
) -> Result<reading::ReadingStats, String> {
    reading::get_reading_stats(&state, &input.day, &input.year_start)
}

#[tauri::command]
pub fn get_reading_days(
    state: State<'_, AppState>,
    start_day: String,
    end_day: String,
) -> Result<Vec<reading::ReadingDay>, String> {
    reading::get_reading_days(&state, &start_day, &end_day)
}

#[tauri::command]
pub fn save_recall_note(
    state: State<'_, AppState>,
    input: reading::SaveRecallNoteInput,
) -> Result<reading::ReadingState, String> {
    reading::save_recall_note(&state, &input.document_id, &input.note)
}
