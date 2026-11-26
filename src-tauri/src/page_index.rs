//! 文本层页索引：跨库搜索要能搜「页内文字」，但 pdf.js 的文本只在打开文档时可用。
//! 因此首次打开（或索引缺失）时由前端抽取每页文本，存进 `page_index`；
//! 这是可重建的派生数据，删除 / 合并后允许缺页，重新打开会自动补齐。

use crate::state::AppState;
use rusqlite::params;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct PageIndexInput {
    pub page: u32,
    pub text: String,
    /// text / ocr；缺省按文本层算。
    #[serde(default)]
    pub source: Option<String>,
}

/// 单页最多保留 4000 字：够搜索，也不会把整本书塞进一行。
const MAX_PAGE_CHARS: usize = 4000;

fn normalize(text: &str) -> String {
    let mut out = String::with_capacity(text.len().min(MAX_PAGE_CHARS * 3));
    let mut last_space = false;
    for ch in text.chars() {
        if ch.is_whitespace() {
            if !last_space && !out.is_empty() {
                out.push(' ');
                last_space = true;
            }
            continue;
        }
        last_space = false;
        out.push(ch);
        if out.chars().count() >= MAX_PAGE_CHARS {
            break;
        }
    }
    out.trim().to_string()
}

pub fn save(state: &AppState, document_id: &str, pages: Vec<PageIndexInput>) -> Result<u32, String> {
    if document_id.trim().is_empty() {
        return Err("document_id 不能为空".into());
    }
    if pages.is_empty() {
        return Ok(0);
    }
    let timestamp = crate::models::now();
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    let mut saved = 0u32;
    for page in pages {
        if page.page == 0 {
            continue;
        }
        let text = normalize(&page.text);
        if text.is_empty() {
            continue;
        }
        transaction
            .execute(
                "INSERT INTO page_index (document_id, page, text, updated_at, source)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(document_id, page) DO UPDATE SET
                 text = excluded.text, updated_at = excluded.updated_at, source = excluded.source",
                params![
                    document_id,
                    page.page,
                    text,
                    timestamp,
                    page.source.unwrap_or_else(|| "text".into())
                ],
            )
            .map_err(|error| error.to_string())?;
        saved += 1;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(saved)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageIndexStats {
    pub documents: i64,
    pub pages: i64,
    pub ocr_pages: i64,
}

pub fn stats(state: &AppState) -> Result<PageIndexStats, String> {
    let database = state.db()?;
    database
        .query_row(
            "SELECT COUNT(DISTINCT document_id), COUNT(*),
                    COALESCE(SUM(CASE WHEN source = 'ocr' THEN 1 ELSE 0 END), 0)
             FROM page_index",
            [],
            |row| {
                Ok(PageIndexStats {
                    documents: row.get(0)?,
                    pages: row.get(1)?,
                    ocr_pages: row.get(2)?,
                })
            },
        )
        .map_err(|error| error.to_string())
}

pub fn list_pages(state: &AppState, document_id: &str) -> Result<Vec<u32>, String> {
    let database = state.db()?;
    let mut statement = database
        .prepare("SELECT page FROM page_index WHERE document_id = ?1 ORDER BY page")
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![document_id], |row| row.get::<_, u32>(0))
        .map_err(|error| error.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::{list_pages, normalize, save, PageIndexInput};
    use crate::state::test_state;

    #[test]
    fn normalizes_whitespace_and_caps_length() {
        assert_eq!(normalize("  第一行\n\n第二行\t  "), "第一行 第二行");
        assert_eq!(normalize(""), "");
        let long = "熵".repeat(5000);
        assert_eq!(normalize(&long).chars().count(), 4000);
    }

    #[test]
    fn search_finds_page_text_and_tags() {
        let (_directory, state) = test_state();
        {
            let database = state.db().unwrap();
            database
                .execute(
                    "INSERT INTO documents (id, title, stored_path, content_hash, created_at, updated_at)
                     VALUES ('d1', '测试教材', '/tmp/x.pdf', 'hash-d1', 'now', 'now')",
                    [],
                )
                .unwrap();
            database
                .execute(
                    "INSERT INTO cards (id, question, due, created_at, updated_at)
                     VALUES ('c1', '线粒体是什么', '2026-01-01', 'now', 'now')",
                    [],
                )
                .unwrap();
            database
                .execute(
                    "INSERT INTO card_tags (card_id, tag, created_at) VALUES ('c1', '细胞结构', 'now')",
                    [],
                )
                .unwrap();
        }
        save(&state, "d1", vec![PageIndexInput {
            page: 3,
            text: "线粒体是细胞的能量工厂，参与氧化磷酸化。".into(),
            source: None,
        }])
        .unwrap();

        let database = state.db().unwrap();
        let page_hits = crate::commands::search_global(&database, "线粒体", 10).unwrap();
        let page = page_hits.iter().find(|hit| hit.kind == "page").expect("应命中页内全文");
        assert_eq!(page.page, Some(3));
        assert!(page.title.contains("测试教材"));
        assert!(page.snippet.contains("线粒体"), "{}", page.snippet);

        let tag_hits = crate::commands::search_global(&database, "细胞", 10).unwrap();
        let tag = tag_hits.iter().find(|hit| hit.kind == "tag").expect("应命中标签");
        assert_eq!(tag.title, "#细胞结构");
        assert!(tag.snippet.contains("1 张卡片"));
    }

    #[test]
    fn saves_and_lists_pages_idempotently() {
        let (_directory, state) = test_state();
        let saved = save(&state, "doc-1", vec![
            PageIndexInput { page: 1, text: "第一页 内容".into(), source: None },
            PageIndexInput { page: 2, text: "  ".into(), source: None },
        ])
        .unwrap();
        assert_eq!(saved, 1, "空白页不落库");
        assert_eq!(list_pages(&state, "doc-1").unwrap(), vec![1]);

        save(&state, "doc-1", vec![PageIndexInput { page: 1, text: "改过的内容".into(), source: Some("ocr".into()) }]).unwrap();
        assert_eq!(list_pages(&state, "doc-1").unwrap(), vec![1]);
        let stats = super::stats(&state).unwrap();
        assert_eq!(stats.documents, 1);
        assert_eq!(stats.pages, 1);
        assert_eq!(stats.ocr_pages, 1, "source=ocr 要计入 OCR 页");
        assert!(save(&state, "", vec![PageIndexInput { page: 1, text: "x".into(), source: None }]).is_err());
    }
}
