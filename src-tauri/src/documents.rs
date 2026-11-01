use crate::{
    models::{document_from_row, now, Document, DOCUMENT_COLUMNS},
    state::AppState,
};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

const PDF_MAGIC: &[u8] = b"%PDF-";
const CHUNK: usize = 64 * 1024;

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| format!("无法打开文件: {error}"))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; CHUNK];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("读取文件失败: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn copy_file(source: &Path, destination: &Path) -> Result<(), String> {
    let mut input = fs::File::open(source).map_err(|error| format!("无法打开源文件: {error}"))?;
    let mut output =
        fs::File::create(destination).map_err(|error| format!("无法创建目标文件: {error}"))?;
    std::io::copy(&mut input, &mut output).map_err(|error| format!("复制文件失败: {error}"))?;
    output
        .sync_all()
        .map_err(|error| format!("写入磁盘失败: {error}"))?;
    Ok(())
}

fn get_document_by_hash(connection: &Connection, hash: &str) -> Result<Option<Document>, String> {
    let query = format!("SELECT {DOCUMENT_COLUMNS} FROM documents WHERE content_hash = ?1");
    connection
        .query_row(&query, params![hash], document_from_row)
        .optional()
        .map_err(|error| error.to_string())
}

pub fn get_document_by_id(connection: &Connection, id: &str) -> Result<Option<Document>, String> {
    let query = format!("SELECT {DOCUMENT_COLUMNS} FROM documents WHERE id = ?1");
    connection
        .query_row(&query, params![id], document_from_row)
        .optional()
        .map_err(|error| error.to_string())
}

fn ensure_pdf_looks_valid(path: &Path) -> Result<(), String> {
    let mut file = fs::File::open(path).map_err(|error| format!("无法打开文件: {error}"))?;
    let mut header = [0_u8; 5];
    let read = file
        .read(&mut header)
        .map_err(|error| format!("读取文件失败: {error}"))?;
    if read < 5 || &header != PDF_MAGIC {
        return Err("所选文件不是有效的 PDF".into());
    }
    Ok(())
}

pub fn import_document(state: &AppState, source_path: String) -> Result<Document, String> {
    let source = PathBuf::from(&source_path);
    if !source.is_absolute() {
        return Err("需要绝对路径".into());
    }
    ensure_pdf_looks_valid(&source)?;

    let hash = sha256_file(&source)?;
    let file_size = source.metadata().map_err(|error| error.to_string())?.len() as i64;
    let title = source
        .file_stem()
        .and_then(|name| name.to_str())
        .unwrap_or("未命名文档")
        .to_string();

    {
        let database = state.db()?;
        if let Some(existing) = get_document_by_hash(&database, &hash)? {
            return Ok(existing);
        }
    }

    let id = uuid::Uuid::new_v4().to_string();
    let timestamp = now();
    let stored_name = format!("{hash}.pdf");
    let stored_path = format!("pdfs/{stored_name}");
    let pdfs_dir = state.data_dir.join("pdfs");
    let tmp_dir = state.data_dir.join("tmp");
    let staged = tmp_dir.join(format!("import-{}.pdf", uuid::Uuid::new_v4()));

    copy_file(&source, &staged)?;
    let final_path = pdfs_dir.join(&stored_name);
    if final_path.exists() {
        let _ = fs::remove_file(&staged);
    } else {
        fs::rename(&staged, &final_path).map_err(|error| {
            let _ = fs::remove_file(&staged);
            format!("移动文件失败: {error}")
        })?;
    }

    let result: Result<Document, String> = (|| {
        let mut database = state.db()?;
        let transaction = database.transaction().map_err(|error| error.to_string())?;
        transaction
            .execute(
                "INSERT INTO documents (id, title, stored_path, original_path, content_hash, file_size, page_count, file_status, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, 'ready', ?7, ?7)",
                params![id, title, stored_path, source_path, hash, file_size, timestamp],
            )
            .map_err(|error| error.to_string())?;
        let document = get_document_by_id(&transaction, &id)?.ok_or("文档写入失败")?;
        transaction.commit().map_err(|error| error.to_string())?;
        Ok(document)
    })();

    match result {
        Ok(document) => Ok(document),
        Err(error) => {
            let _ = fs::remove_file(&final_path);
            Err(error)
        }
    }
}

pub fn resolve_document_path(state: &AppState, id: String) -> Result<String, String> {
    let database = state.db()?;
    let document = get_document_by_id(&database, &id)?.ok_or("文档不存在")?;
    Ok(state
        .data_dir
        .join(document.stored_path)
        .to_string_lossy()
        .into_owned())
}

pub fn update_document_metadata(
    state: &AppState,
    id: String,
    title: String,
    page_count: i64,
) -> Result<(), String> {
    if page_count < 0 {
        return Err("页数不能为负".into());
    }
    let database = state.db()?;
    let affected = database
        .execute(
            "UPDATE documents SET title = ?1, page_count = ?2, updated_at = ?3 WHERE id = ?4",
            params![title.trim(), page_count, now(), id],
        )
        .map_err(|error| error.to_string())?;
    if affected == 0 {
        return Err("文档不存在".into());
    }
    Ok(())
}

pub fn list_documents(state: &AppState) -> Result<Vec<Document>, String> {
    let database = state.db()?;
    let query = format!("SELECT {DOCUMENT_COLUMNS} FROM documents ORDER BY updated_at DESC");
    let mut statement = database
        .prepare(&query)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([], document_from_row)
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())
}

pub fn verify_document(state: &AppState, id: String) -> Result<Document, String> {
    let (document, path) = {
        let database = state.db()?;
        let document = get_document_by_id(&database, &id)?.ok_or("文档不存在")?;
        let path = state.data_dir.join(&document.stored_path);
        (document, path)
    };

    let status = if !path.exists() {
        "missing".to_string()
    } else {
        match sha256_file(&path) {
            Ok(hash) if hash == document.content_hash => "ready".to_string(),
            Ok(_) => "mismatch".to_string(),
            Err(_) => "missing".to_string(),
        }
    };

    if status != document.file_status {
        let database = state.db()?;
        database
            .execute(
                "UPDATE documents SET file_status = ?1, updated_at = ?2 WHERE id = ?3",
                params![status, now(), id],
            )
            .map_err(|error| error.to_string())?;
    }
    let database = state.db()?;
    get_document_by_id(&database, &id)?.ok_or_else(|| "文档不存在".into())
}

pub fn relocate_document(
    state: &AppState,
    id: String,
    source_path: String,
) -> Result<Document, String> {
    let source = PathBuf::from(&source_path);
    ensure_pdf_looks_valid(&source)?;
    let hash = sha256_file(&source)?;

    {
        let database = state.db()?;
        let document = get_document_by_id(&database, &id)?.ok_or("文档不存在")?;
        if hash != document.content_hash {
            return Err("所选文件的内容与原文档不一致".into());
        }
    }

    let pdfs_dir = state.data_dir.join("pdfs");
    let final_path = pdfs_dir.join(format!("{hash}.pdf"));
    if !final_path.exists() {
        copy_file(&source, &final_path)?;
    }
    {
        let database = state.db()?;
        database
            .execute(
                "UPDATE documents SET file_status = 'ready', original_path = ?1, updated_at = ?2 WHERE id = ?3",
                params![source_path, now(), id],
            )
            .map_err(|error| error.to_string())?;
    }
    verify_document(state, id)
}

pub fn delete_document(state: &AppState, id: String, keep_cards: bool) -> Result<(), String> {
    let document = {
        let database = state.db()?;
        get_document_by_id(&database, &id)?.ok_or("文档不存在")?
    };
    let timestamp = now();

    {
        let mut database = state.db()?;
        let transaction = database.transaction().map_err(|error| error.to_string())?;
        if keep_cards {
            transaction
                .execute(
                    "DELETE FROM annotations WHERE card_id IN (SELECT id FROM cards WHERE document_id = ?1)",
                    params![id],
                )
                .map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "UPDATE cards SET document_id = NULL, page = NULL, bbox_x = NULL, bbox_y = NULL,
                        bbox_width = NULL, bbox_height = NULL, surface_pdf = 0, updated_at = ?1
                     WHERE document_id = ?2",
                    params![timestamp, id],
                )
                .map_err(|error| error.to_string())?;
        } else {
            transaction
                .execute("DELETE FROM cards WHERE document_id = ?1", params![id])
                .map_err(|error| error.to_string())?;
        }
        transaction
            .execute("DELETE FROM documents WHERE id = ?1", params![id])
            .map_err(|error| error.to_string())?;
        transaction.commit().map_err(|error| error.to_string())?;
    }

    let pdf_path = state.data_dir.join(&document.stored_path);
    if pdf_path.exists() {
        let _ = fs::remove_file(pdf_path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::test_state;

    fn write_pdf(path: &Path, bytes: &[u8]) {
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn import_deduplicates_by_content_hash() {
        let (directory, state) = test_state();
        let source = directory.join("sample.pdf");
        write_pdf(&source, b"%PDF-1.7 fake content");

        let first = import_document(&state, source.to_string_lossy().to_string()).unwrap();
        let second = import_document(&state, source.to_string_lossy().to_string()).unwrap();
        assert_eq!(first.id, second.id, "相同内容哈希必须去重");

        let documents = list_documents(&state).unwrap();
        assert_eq!(documents.len(), 1);
        let stored = state.data_dir.join(first.stored_path);
        assert!(stored.exists(), "PDF 副本必须存在");
        assert_eq!(first.file_status, "ready");
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn import_rejects_non_pdf() {
        let (directory, state) = test_state();
        let source = directory.join("not-a-pdf.txt");
        write_pdf(&source, b"plain text");
        let error = import_document(&state, source.to_string_lossy().to_string()).unwrap_err();
        assert!(error.contains("PDF"));
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn delete_document_can_keep_cards() {
        let (directory, state) = test_state();
        let source = directory.join("sample.pdf");
        write_pdf(&source, b"%PDF-1.7 keep cards");
        let document = import_document(&state, source.to_string_lossy().to_string()).unwrap();

        let database = state.db().unwrap();
        database
            .execute(
                "INSERT INTO cards (id, document_id, page, bbox_x, bbox_y, bbox_width, bbox_height, excerpt, due, created_at, updated_at)
                 VALUES ('card-1', ?1, 1, 0.1, 0.1, 0.2, 0.2, '摘录', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
                params![document.id],
            )
            .unwrap();
        drop(database);

        delete_document(&state, document.id.clone(), true).unwrap();
        let database = state.db().unwrap();
        let cards: i64 = database
            .query_row("SELECT COUNT(*) FROM cards", [], |row| row.get(0))
            .unwrap();
        assert_eq!(cards, 1, "保留卡片模式必须保留卡片");
        let orphan: i64 = database
            .query_row(
                "SELECT COUNT(*) FROM cards WHERE document_id IS NULL AND surface_pdf = 0",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(orphan, 1);
        drop(database);
        assert!(!state.data_dir.join(&document.stored_path).exists());
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn ranged_read_returns_exact_slice_and_clamps_eof() {
        let (directory, _state) = test_state();
        let path = directory.join("range.pdf");
        fs::write(&path, b"0123456789").unwrap();
        assert_eq!(read_file_range(&path, 2, 6).unwrap(), b"2345");
        assert_eq!(read_file_range(&path, 8, 20).unwrap(), b"89");
        assert!(read_file_range(&path, 20, 30).unwrap().is_empty());
        assert!(read_file_range(&path, 5, 5).is_err());
        assert!(read_file_range(&path, 0, 9 * 1024 * 1024).is_err());
        let _ = fs::remove_dir_all(&directory);
    }

    #[test]
    fn verify_detects_missing_file() {
        let (directory, state) = test_state();
        let source = directory.join("sample.pdf");
        write_pdf(&source, b"%PDF-1.7 to be moved");
        let document = import_document(&state, source.to_string_lossy().to_string()).unwrap();
        let stored = state.data_dir.join(&document.stored_path);
        fs::remove_file(&stored).unwrap();

        let verified = verify_document(&state, document.id.clone()).unwrap();
        assert_eq!(verified.file_status, "missing");

        write_pdf(&stored, b"%PDF-1.7 different bytes");
        let mismatched = verify_document(&state, document.id.clone()).unwrap();
        assert_eq!(mismatched.file_status, "mismatch");
        let _ = fs::remove_dir_all(&directory);
    }
}

/// PDF.js 通过自有 Range 传输按块读取，避免 WebView 整本拉取 500MB 级教材。
pub fn read_pdf_chunk(
    state: &AppState,
    id: String,
    begin: u64,
    end: u64,
) -> Result<Vec<u8>, String> {
    let path = {
        let database = state.db()?;
        let document = get_document_by_id(&database, &id)?.ok_or("文档不存在")?;
        if document.file_status != "ready" {
            return Err("PDF 文件未就绪".into());
        }
        state.data_dir.join(document.stored_path)
    };
    read_file_range(&path, begin, end)
}

fn read_file_range(path: &Path, begin: u64, end: u64) -> Result<Vec<u8>, String> {
    const MAX_CHUNK: u64 = 8 * 1024 * 1024;
    if end <= begin {
        return Err("非法的读取范围".into());
    }
    if end - begin > MAX_CHUNK {
        return Err("单次读取范围过大".into());
    }
    let mut file = fs::File::open(path).map_err(|error| format!("无法打开 PDF: {error}"))?;
    let length = file.metadata().map_err(|error| error.to_string())?.len();
    let start = begin.min(length);
    let finish = end.min(length);
    if start >= finish {
        return Ok(Vec::new());
    }
    file.seek(SeekFrom::Start(start))
        .map_err(|error| error.to_string())?;
    let mut buffer = vec![0_u8; (finish - start) as usize];
    file.read_exact(&mut buffer)
        .map_err(|error| format!("读取 PDF 分块失败: {error}"))?;
    Ok(buffer)
}
