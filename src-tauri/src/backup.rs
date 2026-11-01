use crate::{
    models::{now, BackupResult, Document},
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
    id: String,
    stored_path: String,
    content_hash: String,
    file_size: i64,
}

fn read_documents(connection: &rusqlite::Connection) -> Result<Vec<Document>, String> {
    let mut statement = connection
        .prepare(
            "SELECT id, title, stored_path, original_path, content_hash, file_size, page_count, file_status, created_at, updated_at FROM documents",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], |row| {
            Ok(Document {
                id: row.get(0)?,
                title: row.get(1)?,
                stored_path: row.get(2)?,
                original_path: row.get(3)?,
                content_hash: row.get(4)?,
                file_size: row.get(5)?,
                page_count: row.get(6)?,
                file_status: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

fn add_file_to_zip(zip: &mut ZipWriter<fs::File>, path: &Path, name: &str) -> Result<(), String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    zip.start_file(
        name,
        SimpleFileOptions::default().compression_level(Some(6)),
    )
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
            .query_row(
                "VACUUM INTO ?1",
                params![snapshot_path.to_string_lossy()],
                |_| Ok(()),
            )
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
                add_file_to_zip(&mut zip, &pdf_path, &format!("pdfs/{name}"))?;
            }
        }
        add_file_to_zip(&mut zip, &snapshot_path, "data/pdfnote.db")?;
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
        for statement in [
            "INSERT INTO documents SELECT * FROM import_src.documents",
            "INSERT INTO cards SELECT * FROM import_src.cards",
            "INSERT INTO annotations SELECT * FROM import_src.annotations",
            "INSERT INTO mindmap_layout SELECT * FROM import_src.mindmap_layout",
            "INSERT INTO review_logs SELECT * FROM import_src.review_logs",
        ] {
            transaction
                .execute(statement, [])
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    })();
    transaction
        .execute("DETACH DATABASE import_src", [])
        .map_err(|error| error.to_string())?;
    result?;
    transaction.commit().map_err(|error| error.to_string())?;
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
            .execute(
                "INSERT INTO documents
                 SELECT s.* FROM import_src.documents s
                 WHERE NOT EXISTS (SELECT 1 FROM documents d WHERE d.content_hash = s.content_hash)",
                [],
            )
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
                "INSERT INTO cards
                 SELECT s.* FROM import_src.cards s
                 WHERE NOT EXISTS (SELECT 1 FROM cards c WHERE c.id = s.id)",
                [],
            )
            .map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE cards SET
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
                 FROM import_src.cards s WHERE cards.id = s.id",
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
        Ok(())
    })();
    transaction
        .execute("DETACH DATABASE import_src", [])
        .map_err(|error| error.to_string())?;
    result?;
    transaction.commit().map_err(|error| error.to_string())?;
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
        if source.exists() && !destination.exists() {
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

pub fn auto_backup(state: &AppState) -> Result<String, String> {
    let backups_dir = state.data_dir.join("backups");
    fs::create_dir_all(&backups_dir).map_err(|error| error.to_string())?;
    let timestamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let destination = backups_dir.join(format!("auto-{timestamp}.pdfnote.zip"));
    let result = export_to(&state, &destination)?;

    let mut backups: Vec<PathBuf> = fs::read_dir(&backups_dir)
        .map_err(|error| error.to_string())?
        .filter_map(|entry| entry.ok())
        .filter(|entry| {
            entry
                .path()
                .extension()
                .and_then(|value| value.to_str())
                .map(|value| value == "zip")
                .unwrap_or(false)
                && entry
                    .file_name()
                    .to_str()
                    .map(|value| value.starts_with("auto-"))
                    .unwrap_or(false)
        })
        .map(|entry| entry.path())
        .collect();
    backups.sort();
    while backups.len() > KEEP_AUTO_BACKUPS {
        let oldest = backups.remove(0);
        let _ = fs::remove_file(oldest);
    }
    Ok(result.path)
}
