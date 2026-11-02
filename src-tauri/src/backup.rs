use crate::{
    models::{document_from_row, now, BackupResult, Document, DOCUMENT_COLUMNS},
    state::AppState,
};
use rusqlite::params;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use zip::{read::ZipArchive, write::SimpleFileOptions, ZipWriter};

const KEEP_AUTO_BACKUPS: usize = 5;

struct Manifest {
    schema_version: u32,
    documents: Vec<ManifestDocument>,
}

struct ManifestDocument {
    #[allow(dead_code)]
    id: String,
    stored_path: String,
    content_hash: String,
    #[allow(dead_code)]
    file_size: i64,
}

fn read_documents(connection: &rusqlite::Connection) -> Result<Vec<Document>, String> {
    let query = format!("SELECT {DOCUMENT_COLUMNS} FROM documents");
    let mut statement = connection
        .prepare(&query)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], document_from_row)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn add_file_to_zip(
    zip: &mut ZipWriter<fs::File>,
    path: &Path,
    name: &str,
    compress: bool,
) -> Result<(), String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    // PDF 本身已是压缩格式，再 deflate 会让 500MB 教材消耗数分钟 CPU；直接存储即可。
    let options = if compress {
        SimpleFileOptions::default().compression_level(Some(6))
    } else {
        SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored)
    };
    zip.start_file(name, options)
        .map_err(|error| error.to_string())?;
    std::io::copy(&mut file, zip).map_err(|error| error.to_string())?;
    Ok(())
}

fn export_to(state: &AppState, destination: &Path) -> Result<BackupResult, String> {
    let connection = state.db()?;
    let documents = read_documents(&connection)?;
    let card_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM cards", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    let schema_version: u32 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    drop(connection);

    let tmp_dir = state.data_dir.join("tmp");
    let snapshot_path = tmp_dir.join(format!("snapshot-{}.db", uuid::Uuid::new_v4()));
    {
        let connection = state.db()?;
        connection
            .pragma_update(None, "wal_checkpoint", "TRUNCATE")
            .map_err(|error| error.to_string())?;
        connection
            .execute("VACUUM INTO ?1", params![snapshot_path.to_string_lossy()])
            .map_err(|error| error.to_string())?;
        drop(connection);
    }

    let manifest = serde_json::json!({
        "app": "pdfnote",
        "app_version": env!("CARGO_PKG_VERSION"),
        "schema_version": schema_version,
        "exported_at": now(),
        "documents": documents.iter().map(|document| {
            serde_json::json!({
                "id": document.id,
                "title": document.title,
                "stored_path": document.stored_path,
                "content_hash": document.content_hash,
                "file_size": document.file_size,
            })
        }).collect::<Vec<_>>(),
        "card_count": card_count,
    });

    let result = (|| -> Result<BackupResult, String> {
        let zip_file =
            fs::File::create(destination).map_err(|error| format!("无法创建备份文件: {error}"))?;
        let mut zip = ZipWriter::new(zip_file);
        zip.add_directory("pdfs", SimpleFileOptions::default())
            .map_err(|error| error.to_string())?;
        for document in &documents {
            let pdf_path = state.data_dir.join(&document.stored_path);
            if pdf_path.exists() {
                let name = Path::new(&document.stored_path)
                    .file_name()
                    .and_then(|value| value.to_str())
                    .ok_or("非法的 PDF 文件名")?;
                add_file_to_zip(&mut zip, &pdf_path, &format!("pdfs/{name}"), false)?;
            }
        }
        add_file_to_zip(&mut zip, &snapshot_path, "data/pdfnote.db", true)?;
        let manifest_bytes =
            serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
        zip.start_file("manifest.json", SimpleFileOptions::default())
            .map_err(|error| error.to_string())?;
        zip.write_all(&manifest_bytes)
            .map_err(|error| error.to_string())?;
        zip.finish().map_err(|error| error.to_string())?;

        Ok(BackupResult {
            path: destination.to_string_lossy().into_owned(),
            documents: documents.len() as i64,
            cards: card_count,
        })
    })();

    let _ = fs::remove_file(&snapshot_path);
    result
}

pub fn export_backup(state: &AppState, destination_path: String) -> Result<BackupResult, String> {
    let destination = PathBuf::from(&destination_path);
    if !destination.is_absolute() {
        return Err("需要绝对路径".into());
    }
    export_to(&state, &destination)
}

fn parse_manifest(bytes: &[u8]) -> Result<Manifest, String> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|error| format!("备份清单损坏: {error}"))?;
    if value.get("app").and_then(|v| v.as_str()) != Some("pdfnote") {
        return Err("这不是 PDFNote 备份包".into());
    }
    let schema_version = value
        .get("schema_version")
        .and_then(|v| v.as_u64())
        .ok_or("备份缺少 schema 版本")? as u32;
    if schema_version > crate::db::SCHEMA_VERSION {
        return Err(format!(
            "备份 schema 版本 {schema_version} 高于当前应用支持的版本 {}",
            crate::db::SCHEMA_VERSION
        ));
    }
    let mut documents = Vec::new();
    let list = value
        .get("documents")
        .and_then(|v| v.as_array())
        .ok_or("备份缺少文档清单")?;
    for item in list {
        documents.push(ManifestDocument {
            id: item
                .get("id")
                .and_then(|v| v.as_str())
                .ok_or("备份文档清单缺少 id")?
                .to_string(),
            stored_path: item
                .get("stored_path")
                .and_then(|v| v.as_str())
                .ok_or("备份文档清单缺少存储路径")?
                .to_string(),
            content_hash: item
                .get("content_hash")
                .and_then(|v| v.as_str())
                .ok_or("备份文档清单缺少哈希")?
                .to_string(),
            file_size: item.get("file_size").and_then(|v| v.as_i64()).unwrap_or(0),
        });
    }
    Ok(Manifest {
        schema_version,
        documents,
    })
}

fn safe_zip_name(name: &str) -> Result<PathBuf, String> {
    let path = Path::new(name);
    if path.is_absolute() {
        return Err("备份包含绝对路径".into());
    }
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(value) => {
                let text = value.to_str().ok_or("备份包含非法文件名")?;
                if text.contains("..") {
                    return Err("备份包含非法路径片段".into());
                }
                result.push(text);
            }
            _ => return Err("备份包含非法路径".into()),
        }
    }
    if result.as_os_str().is_empty() {
        return Err("备份包含空路径".into());
    }
    Ok(result)
}

fn extract_zip(archive_path: &Path, target_dir: &Path) -> Result<(), String> {
    let file = fs::File::open(archive_path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("无法读取备份包: {error}"))?;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let name = entry.name().to_string();
        let safe_path = safe_zip_name(&name)?;
        if entry.is_dir() {
            fs::create_dir_all(target_dir.join(safe_path)).map_err(|error| error.to_string())?;
            continue;
        }
        let destination = target_dir.join(safe_path);
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut output = fs::File::create(&destination).map_err(|error| error.to_string())?;
        std::io::copy(&mut entry, &mut output).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn verify_extracted(state: &AppState, staging: &Path, manifest: &Manifest) -> Result<(), String> {
    let data_path = staging.join("data").join("pdfnote.db");
    if !data_path.exists() {
        return Err("备份包缺少数据库文件".into());
    }
    let connection = rusqlite::Connection::open(&data_path)
        .map_err(|error| format!("备份数据库无法打开: {error}"))?;
    let version: u32 = connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("备份数据库损坏: {error}"))?;
    if version != manifest.schema_version {
        return Err("备份数据库版本与清单不一致".into());
    }
    let integrity: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    if integrity != "ok" {
        return Err("备份数据库完整性校验失败".into());
    }
    drop(connection);

    for document in &manifest.documents {
        let file_name = Path::new(&document.stored_path)
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("备份文档路径非法")?
            .to_string();
        let pdf_path = staging.join("pdfs").join(&file_name);
        if !pdf_path.exists() {
            return Err(format!("备份缺少 PDF 文件: {file_name}"));
        }
        let hash = crate::documents::sha256_file(&pdf_path)?;
        if hash != document.content_hash {
            return Err(format!("PDF 文件校验失败: {file_name}"));
        }
        let _ = state;
    }
    Ok(())
}

/// 旧备份（schema v1）没有 last_page 列，导入时必须显式列出列名，避免 `SELECT *` 列数不匹配。
fn document_copy_sql(schema_version: u32, only_missing: bool) -> String {
    let columns = if schema_version >= 2 {
        "id, title, stored_path, original_path, content_hash, file_size, page_count, file_status, created_at, updated_at, last_page"
    } else {
        "id, title, stored_path, original_path, content_hash, file_size, page_count, file_status, created_at, updated_at"
    };
    let selected = columns
        .split(", ")
        .map(|column| format!("s.{column}"))
        .collect::<Vec<_>>()
        .join(", ");
    let condition = if only_missing {
        " WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.content_hash = s.content_hash)"
    } else {
        ""
    };
    format!(
        "INSERT INTO documents ({columns}) SELECT {selected} FROM import_src.documents s{condition}"
    )
}

const CARD_CURRENT_COLUMNS: &str = "id, document_id, page, bbox_x, bbox_y, bbox_width, bbox_height, excerpt, user_note, question, parent_id, sort_order, collapsed, stability, difficulty, elapsed_days, scheduled_days, learning_steps, due, last_review, reps, lapses, review_state, surface_pdf, surface_mindmap, surface_review, created_at, updated_at, excerpt_image";

/// v4 起卡片带 excerpt_image；旧备份没有该列，导入时补 NULL，避免 `SELECT *` 列数不匹配。
fn card_copy_sql(schema_version: u32, condition: &str) -> String {
    let legacy_columns = CARD_CURRENT_COLUMNS
        .split(", ")
        .take(28)
        .collect::<Vec<_>>()
        .join(", ");
    let selected = if schema_version >= 4 {
        CARD_CURRENT_COLUMNS
            .split(", ")
            .map(|column| format!("s.{column}"))
            .collect::<Vec<_>>()
            .join(", ")
    } else {
        format!(
            "{}, NULL",
            legacy_columns
                .split(", ")
                .map(|column| format!("s.{column}"))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    format!(
        "INSERT INTO cards ({CARD_CURRENT_COLUMNS}) SELECT {selected} FROM import_src.cards s{condition}"
    )
}

/// 旧备份（0.6.0 之前）没有标签/链接/墨迹表，导入时先判断是否存在。
fn import_has_table(connection: &rusqlite::Connection, table: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM import_src.sqlite_master WHERE type = 'table' AND name = ?1)",
            params![table],
            |row| row.get::<_, bool>(0),
        )
        .map_err(|error| error.to_string())
}

fn copy_table_if_present(connection: &rusqlite::Connection, table: &str) -> Result<(), String> {
    if import_has_table(connection, table)? {
        connection
            .execute(
                &format!("INSERT INTO {table} SELECT * FROM import_src.{table}"),
                [],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn import_overwrite(
    state: &AppState,
    staging: &Path,
    manifest: &Manifest,
) -> Result<BackupResult, String> {
    let source_db = staging.join("data").join("pdfnote.db");
    let mut connection = state.db()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    for table in [
        "review_logs",
        "mindmap_layout",
        "annotations",
        "card_links",
        "card_tags",
        "page_inks",
        "cards",
        "documents",
    ] {
        transaction
            .execute(&format!("DELETE FROM {table}"), [])
            .map_err(|error| error.to_string())?;
    }
    transaction
        .execute(
            "ATTACH DATABASE ?1 AS import_src",
            params![source_db.to_string_lossy()],
        )
        .map_err(|error| error.to_string())?;
    let result = (|| -> Result<(), String> {
        let documents_statement = document_copy_sql(manifest.schema_version, false);
        for statement in [
            documents_statement.as_str(),
            card_copy_sql(manifest.schema_version, "").as_str(),
            "INSERT INTO annotations SELECT * FROM import_src.annotations",
            "INSERT INTO mindmap_layout SELECT * FROM import_src.mindmap_layout",
            "INSERT INTO review_logs SELECT * FROM import_src.review_logs",
        ] {
            transaction
                .execute(statement, [])
                .map_err(|error| error.to_string())?;
        }
        for table in ["card_tags", "card_links", "page_inks"] {
            copy_table_if_present(&transaction, table)?;
        }
        Ok(())
    })();
    result?;
    transaction.commit().map_err(|error| error.to_string())?;
    // 事务提交后再解除挂载；即使驱动缓存语句导致 DETACH 失败，数据已安全提交。
    let _ = connection.execute("DETACH DATABASE import_src", []);
    drop(connection);
    sync_pdf_files(state, staging, manifest)
}

fn import_merge(
    state: &AppState,
    staging: &Path,
    manifest: &Manifest,
) -> Result<BackupResult, String> {
    let source_db = staging.join("data").join("pdfnote.db");
    let mut connection = state.db()?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "ATTACH DATABASE ?1 AS import_src",
            params![source_db.to_string_lossy()],
        )
        .map_err(|error| error.to_string())?;
    let result = (|| -> Result<(), String> {
        transaction
            .execute(&document_copy_sql(manifest.schema_version, true), [])
            .map_err(|error| error.to_string())?;
        // 新导入的卡片需要修正文档引用：备份里的 document_id 在本库中可能属于另一个同内容文档。
        transaction
            .execute(
                "UPDATE import_src.cards SET document_id = (
                    SELECT d.id FROM documents d
                    WHERE d.content_hash = (SELECT s2.content_hash FROM import_src.documents s2 WHERE s2.id = import_src.cards.document_id)
                ) WHERE document_id IS NOT NULL",
                [],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                &card_copy_sql(
                    manifest.schema_version,
                    " WHERE NOT EXISTS (SELECT 1 FROM cards c WHERE c.id = s.id)",
                ),
                [],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE cards AS c SET
                    excerpt = s.excerpt, user_note = s.user_note, question = s.question,
                    parent_id = CASE WHEN c.parent_id IS NULL THEN s.parent_id ELSE c.parent_id END,
                    sort_order = CASE WHEN c.updated_at < s.updated_at THEN s.sort_order ELSE c.sort_order END,
                    collapsed = CASE WHEN c.updated_at < s.updated_at THEN s.collapsed ELSE c.collapsed END,
                    stability = CASE WHEN c.updated_at < s.updated_at THEN s.stability ELSE c.stability END,
                    difficulty = CASE WHEN c.updated_at < s.updated_at THEN s.difficulty ELSE c.difficulty END,
                    elapsed_days = CASE WHEN c.updated_at < s.updated_at THEN s.elapsed_days ELSE c.elapsed_days END,
                    scheduled_days = CASE WHEN c.updated_at < s.updated_at THEN s.scheduled_days ELSE c.scheduled_days END,
                    learning_steps = CASE WHEN c.updated_at < s.updated_at THEN s.learning_steps ELSE c.learning_steps END,
                    due = CASE WHEN c.updated_at < s.updated_at THEN s.due ELSE c.due END,
                    last_review = CASE WHEN c.updated_at < s.updated_at THEN s.last_review ELSE c.last_review END,
                    reps = CASE WHEN c.updated_at < s.updated_at THEN s.reps ELSE c.reps END,
                    lapses = CASE WHEN c.updated_at < s.updated_at THEN s.lapses ELSE c.lapses END,
                    review_state = CASE WHEN c.updated_at < s.updated_at THEN s.review_state ELSE c.review_state END,
                    surface_pdf = MAX(c.surface_pdf, s.surface_pdf),
                    surface_mindmap = MAX(c.surface_mindmap, s.surface_mindmap),
                    surface_review = MAX(c.surface_review, s.surface_review),
                    updated_at = CASE WHEN c.updated_at < s.updated_at THEN s.updated_at ELSE c.updated_at END
                 FROM import_src.cards s WHERE c.id = s.id",
                [],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO annotations
                 SELECT s.* FROM import_src.annotations s
                 WHERE NOT EXISTS (SELECT 1 FROM annotations a WHERE a.id = s.id)
                   AND EXISTS (SELECT 1 FROM cards c WHERE c.id = s.card_id)",
                [],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO mindmap_layout
                 SELECT s.* FROM import_src.mindmap_layout s
                 WHERE EXISTS (SELECT 1 FROM cards c WHERE c.id = s.card_id)
                 ON CONFLICT(canvas_id, card_id) DO UPDATE SET
                    x = excluded.x, y = excluded.y, updated_at = excluded.updated_at",
                [],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO review_logs
                 SELECT s.* FROM import_src.review_logs s
                 WHERE NOT EXISTS (SELECT 1 FROM review_logs r WHERE r.client_event_id = s.client_event_id)
                   AND EXISTS (SELECT 1 FROM cards c WHERE c.id = s.card_id)",
                [],
            )
            .map_err(|error| error.to_string())?;
        if import_has_table(&transaction, "page_inks")? {
            // 墨迹挂在文档上，合并模式要按内容哈希重新指向本地文档。
            transaction
                .execute(
                    "UPDATE import_src.page_inks SET document_id = (
                        SELECT d.id FROM documents d
                        WHERE d.content_hash = (SELECT s2.content_hash FROM import_src.documents s2 WHERE s2.id = import_src.page_inks.document_id)
                    ) WHERE document_id IS NOT NULL",
                    [],
                )
                .map_err(|error| error.to_string())?;
        }
        if import_has_table(&transaction, "card_tags")? {
            transaction
                .execute(
                    "INSERT INTO card_tags
                     SELECT s.* FROM import_src.card_tags s
                     WHERE NOT EXISTS (SELECT 1 FROM card_tags t WHERE t.card_id = s.card_id AND t.tag = s.tag)",
                    [],
                )
                .map_err(|error| error.to_string())?;
        }
        if import_has_table(&transaction, "card_links")? {
            transaction
                .execute(
                    "INSERT INTO card_links
                     SELECT s.* FROM import_src.card_links s
                     WHERE NOT EXISTS (SELECT 1 FROM card_links l WHERE l.id = s.id)",
                    [],
                )
                .map_err(|error| error.to_string())?;
        }
        if import_has_table(&transaction, "page_inks")? {
            transaction
                .execute(
                    "INSERT INTO page_inks
                     SELECT s.* FROM import_src.page_inks s
                     WHERE NOT EXISTS (SELECT 1 FROM page_inks i WHERE i.id = s.id)",
                    [],
                )
                .map_err(|error| error.to_string())?;
        }

        Ok(())
    })();
    result?;
    transaction.commit().map_err(|error| error.to_string())?;
    // 事务提交后再解除挂载；即使驱动缓存语句导致 DETACH 失败，数据已安全提交。
    let _ = connection.execute("DETACH DATABASE import_src", []);
    drop(connection);
    sync_pdf_files(state, staging, manifest)
}

fn sync_pdf_files(
    state: &AppState,
    staging: &Path,
    manifest: &Manifest,
) -> Result<BackupResult, String> {
    let pdfs_dir = state.data_dir.join("pdfs");
    let mut count = 0_i64;
    for document in &manifest.documents {
        let file_name = Path::new(&document.stored_path)
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or("备份文档路径非法")?
            .to_string();
        let source = staging.join("pdfs").join(&file_name);
        let destination = pdfs_dir.join(&file_name);
        let destination_valid = destination.exists()
            && crate::documents::sha256_file(&destination)
                .map(|hash| hash == document.content_hash)
                .unwrap_or(false);
        if source.exists() && !destination_valid {
            fs::copy(&source, &destination).map_err(|error| error.to_string())?;
        }
        if destination.exists() {
            count += 1;
        }
    }
    let connection = state.db()?;
    let card_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM cards", [], |row| row.get(0))
        .map_err(|error| error.to_string())?;
    Ok(BackupResult {
        path: staging.to_string_lossy().into_owned(),
        documents: count,
        cards: card_count,
    })
}

pub fn import_backup(
    state: &AppState,
    source_path: String,
    mode: String,
) -> Result<BackupResult, String> {
    if mode != "merge" && mode != "overwrite" {
        return Err("导入模式必须是 merge 或 overwrite".into());
    }
    let archive_path = PathBuf::from(&source_path);
    if !archive_path.is_absolute() || !archive_path.exists() {
        return Err("备份文件不存在".into());
    }

    let staging = state
        .data_dir
        .join("tmp")
        .join(format!("import-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
    let result = (|| -> Result<BackupResult, String> {
        extract_zip(&archive_path, &staging)?;
        let manifest_bytes =
            fs::read(staging.join("manifest.json")).map_err(|_| "备份缺少 manifest.json")?;
        let manifest = parse_manifest(&manifest_bytes)?;
        verify_extracted(&state, &staging, &manifest)?;
        if mode == "overwrite" {
            import_overwrite(&state, &staging, &manifest)
        } else {
            import_merge(&state, &staging, &manifest)
        }
    })();

    let _ = fs::remove_dir_all(&staging);
    result
}

fn latest_data_change(state: &AppState) -> Result<Option<i64>, String> {
    let connection = state.db()?;
    let value: Option<String> = connection
        .query_row(
            "SELECT MAX(value) FROM (
                SELECT MAX(updated_at) AS value FROM documents
                UNION ALL SELECT MAX(updated_at) FROM cards
                UNION ALL SELECT MAX(reviewed_at) FROM review_logs
             )",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(value.and_then(|value| {
        chrono::DateTime::parse_from_rfc3339(&value)
            .ok()
            .map(|date| date.timestamp_millis())
    }))
}

fn backup_start_millis(path: &Path) -> Option<i64> {
    use chrono::TimeZone;
    let name = path.file_name()?.to_str()?;
    let raw = name.strip_prefix("auto-")?.strip_suffix(".pdfnote.zip")?;
    let naive = chrono::NaiveDateTime::parse_from_str(raw, "%Y%m%d-%H%M%S").ok()?;
    chrono::Local
        .from_local_datetime(&naive)
        .single()
        .map(|date| date.timestamp_millis())
}

pub fn auto_backup(state: &AppState) -> Result<String, String> {
    let _guard = state.backup_lock.lock().map_err(|_| "备份锁不可用")?;
    let backups_dir = state.data_dir.join("backups");
    fs::create_dir_all(&backups_dir).map_err(|error| error.to_string())?;

    let mut backups: Vec<PathBuf> = fs::read_dir(&backups_dir)
        .map_err(|error| error.to_string())?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|value| value.to_str())
                .map(|value| value.starts_with("auto-") && value.ends_with(".zip"))
                .unwrap_or(false)
        })
        .collect();
    backups.sort();

    // 数据没有变化时复用最近备份，避免每次启动或每次打开大 PDF 都复制数百 MB。
    if let (Some(latest), Some(latest_change)) = (backups.last(), latest_data_change(state)?) {
        // 备份文件名只精确到秒，两边毫秒截断后再比较，避免同一秒内的写入反复触发备份。
        if backup_start_millis(latest)
            .map(|value| latest_change / 1000 <= value / 1000)
            .unwrap_or(false)
        {
            return Ok(latest.to_string_lossy().into_owned());
        }
    }

    let timestamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let destination = backups_dir.join(format!("auto-{timestamp}.pdfnote.zip"));
    let result = export_to(state, &destination)?;
    backups.push(destination);

    while backups.len() > KEEP_AUTO_BACKUPS {
        let oldest = backups.remove(0);
        let _ = fs::remove_file(oldest);
    }
    Ok(result.path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        cards::create_card,
        documents::import_document,
        models::{AnnotationGeometry, AnnotationInput, CreateCardInput, NormalizedBBox},
        state::test_state,
    };

    fn prepare_state() -> (std::path::PathBuf, AppState) {
        let (directory, state) = test_state();
        let pdf_path = directory.join("source.pdf");
        fs::write(&pdf_path, b"%PDF-1.7 backup roundtrip").unwrap();
        let document = import_document(&state, pdf_path.to_string_lossy().to_string()).unwrap();
        let bbox = NormalizedBBox {
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.1,
        };
        create_card(
            &state,
            CreateCardInput {
                source_ref: Some(crate::models::SourceRef {
                    document_id: document.id,
                    page: 1,
                    bbox: bbox.clone(),
                }),
                excerpt: "备份测试摘录".into(),
                user_note: "笔记".into(),
                question: "问题".into(),
                parent_id: None,
                sort_order: 0,
                excerpt_image: Some("data:image/jpeg;base64,ZmFrZQ==".into()),
                annotation: Some(AnnotationInput {
                    kind: "highlight".into(),
                    geometry: AnnotationGeometry { rects: vec![bbox] },
                    style: serde_json::json!({}),
                }),
            },
        )
        .unwrap();
        (directory, state)
    }

    #[test]
    fn document_copy_sql_is_compatible_with_legacy_backups() {
        let legacy = document_copy_sql(1, false);
        assert!(!legacy.contains("last_page"));
        assert!(legacy.contains("s.content_hash"));
        let current = document_copy_sql(2, true);
        assert!(current.contains("last_page"));
        assert!(current.contains("NOT EXISTS"));
    }

    #[test]
    fn card_copy_sql_is_compatible_with_legacy_backups() {
        let legacy = card_copy_sql(3, "");
        assert!(legacy.contains("s.created_at, s.updated_at, NULL FROM import_src.cards s"));
        assert!(legacy.contains("INSERT INTO cards ("));
        assert!(legacy.contains("excerpt_image"));
        assert!(!legacy.contains("s.excerpt_image"));
        let current = card_copy_sql(
            4,
            " WHERE NOT EXISTS (SELECT 1 FROM cards c WHERE c.id = s.id)",
        );
        assert!(current.contains("s.excerpt_image"));
        assert!(current.contains("NOT EXISTS"));
    }

    #[test]
    fn export_import_roundtrip_restores_data_and_pdf() {
        let (source_dir, source_state) = prepare_state();
        // 标签、链接、墨迹也要随备份往返。
        let card = crate::cards::list_cards(&source_state, None)
            .unwrap()
            .remove(0);
        crate::cards::set_card_tags(&source_state, card.id.clone(), vec!["备份".into()]).unwrap();
        let document = crate::documents::list_documents(&source_state)
            .unwrap()
            .remove(0);
        crate::cards::create_page_ink(
            &source_state,
            document.id.clone(),
            1,
            NormalizedBBox {
                x: 0.2,
                y: 0.2,
                width: 0.2,
                height: 0.2,
            },
            serde_json::json!({
                "color": "#2f6f8f",
                "width": 0.0028,
                "points": [[0.2, 0.2], [0.4, 0.3]]
            }),
        )
        .unwrap();
        let second = create_card(
            &source_state,
            CreateCardInput {
                source_ref: None,
                excerpt: String::new(),
                user_note: String::new(),
                question: "第二张卡片".into(),
                parent_id: None,
                sort_order: 0,
                annotation: None,
                excerpt_image: None,
            },
        )
        .unwrap();
        crate::cards::create_card_link(&source_state, card.id.clone(), second.id).unwrap();

        let archive = source_dir.join("backup.zip");
        let exported = export_backup(&source_state, archive.to_string_lossy().to_string()).unwrap();
        assert_eq!(exported.documents, 1);
        assert_eq!(exported.cards, 2);
        assert!(archive.exists());

        let (_target_dir, target_state) = test_state();
        let imported = import_backup(
            &target_state,
            archive.to_string_lossy().to_string(),
            "merge".into(),
        )
        .unwrap();
        assert_eq!(imported.documents, 1);
        assert_eq!(imported.cards, 2);

        let database = target_state.db().unwrap();
        let cards: i64 = database
            .query_row("SELECT COUNT(*) FROM cards", [], |row| row.get(0))
            .unwrap();
        let annotations: i64 = database
            .query_row("SELECT COUNT(*) FROM annotations", [], |row| row.get(0))
            .unwrap();
        let documents: i64 = database
            .query_row("SELECT COUNT(*) FROM documents", [], |row| row.get(0))
            .unwrap();
        assert_eq!((documents, cards, annotations), (1, 2, 1));
        let tags: i64 = database
            .query_row("SELECT COUNT(*) FROM card_tags", [], |row| row.get(0))
            .unwrap();
        let links: i64 = database
            .query_row("SELECT COUNT(*) FROM card_links", [], |row| row.get(0))
            .unwrap();
        let inks: i64 = database
            .query_row("SELECT COUNT(*) FROM page_inks", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            (tags, links, inks),
            (1, 1, 1),
            "标签/链接/墨迹必须随备份恢复"
        );
        let with_image: i64 = database
            .query_row(
                "SELECT COUNT(*) FROM cards WHERE excerpt_image IS NOT NULL",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(with_image, 1, "摘录图像必须随备份恢复");
        drop(database);
        let document = crate::documents::list_documents(&target_state)
            .unwrap()
            .remove(0);
        assert!(target_state.data_dir.join(document.stored_path).exists());

        let reimported = import_backup(
            &target_state,
            archive.to_string_lossy().to_string(),
            "merge".into(),
        )
        .unwrap();
        assert_eq!(reimported.cards, 2, "重复导入必须幂等");
        let _ = fs::remove_dir_all(&source_dir);
    }

    #[test]
    fn import_rejects_unknown_schema_without_touching_data() {
        let (directory, state) = prepare_state();
        let bad_archive = directory.join("bad.zip");
        {
            let file = fs::File::create(&bad_archive).unwrap();
            let mut zip = ZipWriter::new(file);
            zip.start_file("manifest.json", SimpleFileOptions::default())
                .unwrap();
            zip.write_all(br#"{"app":"pdfnote","schema_version":999,"documents":[]}"#)
                .unwrap();
            zip.finish().unwrap();
        }
        let error = import_backup(
            &state,
            bad_archive.to_string_lossy().to_string(),
            "overwrite".into(),
        )
        .unwrap_err();
        assert!(error.contains("schema") || error.contains("版本"));
        let database = state.db().unwrap();
        let cards: i64 = database
            .query_row("SELECT COUNT(*) FROM cards", [], |row| row.get(0))
            .unwrap();
        assert_eq!(cards, 1, "失败导入不能破坏现有数据");
        drop(database);
        let _ = fs::remove_dir_all(&directory);
    }
}

#[cfg(test)]
mod overwrite_tests {
    use super::*;
    use crate::{
        cards::create_card,
        documents::import_document,
        models::CreateCardInput,
        state::{test_state, AppState},
    };

    fn seed(state: &AppState, directory: &Path, name: &str, content: &[u8]) {
        let pdf_path = directory.join(format!("{name}.pdf"));
        fs::write(&pdf_path, content).unwrap();
        let document = import_document(state, pdf_path.to_string_lossy().to_string()).unwrap();
        create_card(
            state,
            CreateCardInput {
                source_ref: None,
                excerpt: format!("{name}-card"),
                user_note: String::new(),
                question: String::new(),
                parent_id: None,
                sort_order: 0,
                annotation: None,
                excerpt_image: None,
            },
        )
        .unwrap();
        assert!(!document.id.is_empty());
    }

    #[test]
    fn overwrite_replaces_existing_logical_data() {
        let (source_dir, source_state) = test_state();
        seed(&source_state, &source_dir, "source", b"%PDF-1.7 source");
        let archive = source_dir.join("source-backup.zip");
        export_backup(&source_state, archive.to_string_lossy().to_string()).unwrap();

        let (target_dir, target_state) = test_state();
        seed(
            &target_state,
            &target_dir,
            "target-one",
            b"%PDF-1.7 target one",
        );
        seed(
            &target_state,
            &target_dir,
            "target-two",
            b"%PDF-1.7 target two",
        );

        let imported = import_backup(
            &target_state,
            archive.to_string_lossy().to_string(),
            "overwrite".into(),
        )
        .unwrap();
        assert_eq!(imported.cards, 1, "覆盖模式只应保留备份中的卡片");
        let database = target_state.db().unwrap();
        let cards: i64 = database
            .query_row("SELECT COUNT(*) FROM cards", [], |row| row.get(0))
            .unwrap();
        let documents: i64 = database
            .query_row("SELECT COUNT(*) FROM documents", [], |row| row.get(0))
            .unwrap();
        assert_eq!((documents, cards), (1, 1));
        drop(database);
        let _ = fs::remove_dir_all(&source_dir);
        let _ = fs::remove_dir_all(&target_dir);
    }
}

#[cfg(test)]
mod backup_freshness_tests {
    use super::*;
    use crate::{
        cards::create_card,
        models::CreateCardInput,
        state::{test_state, AppState},
    };

    fn card(state: &AppState, title: &str) {
        create_card(
            state,
            CreateCardInput {
                source_ref: None,
                excerpt: String::new(),
                user_note: String::new(),
                question: title.into(),
                parent_id: None,
                sort_order: 0,
                annotation: None,
                excerpt_image: None,
            },
        )
        .unwrap();
    }

    #[test]
    fn auto_backup_skips_unchanged_data() {
        let (directory, state) = test_state();
        card(&state, "first");
        let first = auto_backup(&state).unwrap();
        let second = auto_backup(&state).unwrap();
        assert_eq!(first, second, "数据未变化时不应重复复制备份");

        std::thread::sleep(std::time::Duration::from_millis(1100));
        card(&state, "second");
        let third = auto_backup(&state).unwrap();
        assert_ne!(first, third, "数据变化后应生成新的备份");
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn pdf_is_stored_without_recompression() {
        let (directory, state) = test_state();
        let pdf_path = directory.join("large.pdf");
        fs::write(&pdf_path, b"%PDF-1.7 payload").unwrap();
        crate::documents::import_document(&state, pdf_path.to_string_lossy().to_string()).unwrap();
        let archive_path = directory.join("backup.zip");
        export_backup(&state, archive_path.to_string_lossy().to_string()).unwrap();

        let mut archive = ZipArchive::new(fs::File::open(&archive_path).unwrap()).unwrap();
        let name = archive
            .file_names()
            .find(|name| name.starts_with("pdfs/"))
            .unwrap()
            .to_string();
        let entry = archive.by_name(&name).unwrap();
        assert_eq!(entry.compression(), zip::CompressionMethod::Stored);
        drop(entry);
        drop(archive);
        let _ = fs::remove_dir_all(&directory);
    }
}
