//! AnkiDroid 导出的 txt 导入：先解析预览，再按勾选的牌组批量建卡。
//!
//! 支持两种实测格式：
//! - 标准 6 列：`#guid/#notetype/#deck/#tags column` 元数据 + Front / Back；
//! - 只有正面：Front 字段用引号包裹且跨行（问题 + 空行 + 闭合引号），Back 为空。
//! 字段允许引号包裹、`""` 转义、HTML 内联样式；牌组用 `::` 表示层级。

use crate::{canvases, models::now, state::AppState};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::Path};
use uuid::Uuid;

const MAX_FILE_BYTES: u64 = 24 * 1024 * 1024;
const UNGROUPED_DECK: &str = "未分组";

#[derive(Debug, Clone)]
struct AnkiNote {
    deck: String,
    deck_path: Vec<String>,
    front: String,
    back: String,
    tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnkiDeckPreview {
    pub name: String,
    pub count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnkiSample {
    pub deck: String,
    pub front: String,
    pub back: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnkiPreview {
    /// anki-standard（6 列）或 anki-front-only（只有正面）
    pub format: String,
    pub total: u32,
    pub has_answers: bool,
    pub decks: Vec<AnkiDeckPreview>,
    pub samples: Vec<AnkiSample>,
}

#[derive(Debug, Deserialize)]
pub struct AnkiImportInput {
    pub source_path: String,
    pub canvas_id: String,
    /// None = 全部牌组；Some([]) = 一张都不导入。
    pub deck_names: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnkiImportResult {
    pub imported: u32,
    pub groups: u32,
    pub skipped: u32,
    pub canvas_id: String,
}

#[derive(Default)]
struct AnkiHeader {
    separator: char,
    html: bool,
    guid_col: Option<usize>,
    notetype_col: Option<usize>,
    deck_col: Option<usize>,
    tags_col: Option<usize>,
}

fn read_source(path: &str) -> Result<String, String> {
    let metadata = fs::metadata(Path::new(path))
        .map_err(|error| format!("无法读取 txt 文件：{error}"))?;
    if metadata.len() > MAX_FILE_BYTES {
        return Err("文件超过 24 MB，请先拆分后再导入".into());
    }
    let bytes = fs::read(Path::new(path))
        .map_err(|error| format!("无法读取 txt 文件：{error}"))?;
    let text = String::from_utf8(bytes)
        .map_err(|_| "文件不是 UTF-8 编码，请用 AnkiDroid 重新导出为 UTF-8 txt".to_string())?;
    Ok(text.trim_start_matches('\u{feff}').replace("\r\n", "\n"))
}

fn parse_header(content: &str) -> (AnkiHeader, String) {
    let mut header = AnkiHeader { separator: '\t', html: false, ..Default::default() };
    let mut data_lines: Vec<&str> = Vec::new();
    for line in content.split('\n') {
        if data_lines.is_empty() && line.trim_start().starts_with('#') {
            let trimmed = line.trim();
            if let Some(value) = trimmed.strip_prefix("#separator:") {
                let value = value.to_ascii_lowercase();
                header.separator = if value.contains("comma") { ',' }
                    else if value.contains("semicolon") { ';' }
                    else { '\t' };
            } else if let Some(value) = trimmed.strip_prefix("#html:") {
                header.html = value.eq_ignore_ascii_case("true");
            } else if let Some(column) = column_directive(trimmed, "#guid column:") {
                header.guid_col = column;
            } else if let Some(column) = column_directive(trimmed, "#notetype column:") {
                header.notetype_col = column;
            } else if let Some(column) = column_directive(trimmed, "#deck column:") {
                header.deck_col = column;
            } else if let Some(column) = column_directive(trimmed, "#tags column:") {
                header.tags_col = column;
            }
            continue;
        }
        data_lines.push(line);
    }
    (header, data_lines.join("\n"))
}

/// Anki 的列号是 1-based；非法或缺省返回 None。
fn column_directive(line: &str, prefix: &str) -> Option<Option<usize>> {
    let value = line.strip_prefix(prefix)?;
    Some(value.trim().parse::<usize>().ok().filter(|n| *n > 0).map(|n| n - 1))
}

/// TSV 状态机：引号内的 tab / 换行属于字段内容，`""` 表示一个字面引号。
fn parse_records(data: &str, separator: char) -> Vec<Vec<String>> {
    let mut records = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut field = String::new();
    let mut in_quotes = false;
    let mut touched = false;
    let mut chars = data.chars().peekable();
    while let Some(ch) = chars.next() {
        if in_quotes {
            if ch == '"' {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    field.push('"');
                } else {
                    in_quotes = false;
                }
            } else if ch != '\r' {
                field.push(ch);
            }
            touched = true;
            continue;
        }
        match ch {
            '"' if field.is_empty() => { in_quotes = true; touched = true; }
            '"' => { field.push('"'); touched = true; }
            value if value == separator => {
                row.push(std::mem::take(&mut field));
                touched = true;
            }
            '\n' => {
                row.push(std::mem::take(&mut field));
                if touched || row.len() > 1 {
                    records.push(std::mem::take(&mut row));
                } else {
                    row.clear();
                }
                touched = false;
            }
            '\r' => {}
            value => { field.push(value); touched = true; }
        }
    }
    if touched || !field.is_empty() || !row.is_empty() {
        row.push(field);
        records.push(row);
    }
    records
}

/// `#html:true` 时把块级标签转成换行、剥离内联标签、解码常见实体。
fn clean_html(raw: &str, html: bool) -> String {
    let mut text = raw.to_string();
    if html {
        let chars: Vec<char> = text.chars().collect();
        let mut out = String::new();
        let mut index = 0;
        while index < chars.len() {
            if chars[index] == '<' {
                let mut end = index + 1;
                while end < chars.len() && chars[end] != '>' {
                    end += 1;
                }
                if end < chars.len() {
                    let tag: String = chars[index + 1..end].iter().collect::<String>().to_lowercase();
                    let name = tag.trim_start_matches('/').split_whitespace().next().unwrap_or("");
                    if matches!(name, "br" | "p" | "div" | "li" | "tr" | "hr") {
                        out.push('\n');
                    }
                    index = end + 1;
                    continue;
                }
            }
            out.push(chars[index]);
            index += 1;
        }
        text = out;
        for (entity, value) in [
            ("&nbsp;", " "), ("&lt;", "<"), ("&gt;", ">"),
            ("&quot;", "\""), ("&#39;", "'"), ("&apos;", "'"), ("&amp;", "&"),
        ] {
            text = text.replace(entity, value);
        }
    }
    let lines: Vec<String> = text
        .split('\n')
        .map(|line| line.trim_end().to_string())
        .collect();
    let mut joined = lines.join("\n");
    while joined.contains("\n\n\n") {
        joined = joined.replace("\n\n\n", "\n\n");
    }
    joined.trim().to_string()
}

fn normalize_tag(value: &str) -> Option<String> {
    let tag = value.trim().trim_start_matches('#').trim();
    if tag.is_empty() || tag.chars().count() > 40 {
        None
    } else {
        Some(tag.to_string())
    }
}

fn extract_notes(content: &str) -> Result<(Vec<AnkiNote>, String), String> {
    let (header, data) = parse_header(content);
    let records = parse_records(&data, header.separator);
    let max_columns = records.iter().map(|row| row.len()).max().unwrap_or(0);
    let mut meta_columns = std::collections::HashSet::new();
    for column in [header.guid_col, header.notetype_col, header.deck_col, header.tags_col]
        .into_iter()
        .flatten()
    {
        meta_columns.insert(column);
    }
    let content_columns: Vec<usize> = (0..max_columns)
        .filter(|column| !meta_columns.contains(column))
        .collect();
    let front_col = content_columns.first().copied();
    let back_col = content_columns.get(1).copied();
    if front_col.is_none() {
        return Err("没有识别出问题列，请确认这是 AnkiDroid 导出的 txt".into());
    }
    let format = if header.deck_col.is_some() { "anki-standard" } else { "anki-front-only" };

    let mut notes = Vec::new();
    for row in &records {
        let field = |column: Option<usize>| -> String {
            column
                .and_then(|index| row.get(index))
                .map(|value| clean_html(value, header.html))
                .unwrap_or_default()
        };
        let front = field(front_col);
        if front.trim().is_empty() {
            continue;
        }
        let back = field(back_col);
        let raw_deck = field(header.deck_col);
        let deck = if raw_deck.trim().is_empty() { UNGROUPED_DECK.to_string() } else { raw_deck };
        let mut deck_path: Vec<String> = deck
            .split("::")
            .map(|part| part.trim().to_string())
            .filter(|part| !part.is_empty())
            .collect();
        if deck_path.is_empty() {
            deck_path.push(UNGROUPED_DECK.into());
        }
        let mut tags: Vec<String> = field(header.tags_col)
            .split_whitespace()
            .filter_map(normalize_tag)
            .collect();
        // 牌组末级也写成标签，方便在卡片里检索章节。
        if let Some(leaf) = deck_path.last().and_then(|value| normalize_tag(value)) {
            if !tags.contains(&leaf) {
                tags.push(leaf);
            }
        }
        tags.truncate(6);
        notes.push(AnkiNote { deck, deck_path, front, back, tags });
    }
    if notes.is_empty() {
        return Err("没有解析出任何卡片，请检查导出时是否选择了「包含牌组 / 标签」".into());
    }
    Ok((notes, format.into()))
}

pub fn preview_anki_txt(source_path: &str) -> Result<AnkiPreview, String> {
    let content = read_source(source_path)?;
    let (notes, format) = extract_notes(&content)?;
    let mut counts: HashMap<String, u32> = HashMap::new();
    for note in &notes {
        *counts.entry(note.deck.clone()).or_insert(0) += 1;
    }
    let mut decks: Vec<AnkiDeckPreview> = counts
        .into_iter()
        .map(|(name, count)| AnkiDeckPreview { name, count })
        .collect();
    decks.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
    let samples = notes
        .iter()
        .take(5)
        .map(|note| AnkiSample {
            deck: note.deck.clone(),
            front: truncate(&note.front, 180),
            back: truncate(&note.back, 180),
        })
        .collect();
    Ok(AnkiPreview {
        format,
        total: notes.len() as u32,
        has_answers: notes.iter().any(|note| !note.back.trim().is_empty()),
        decks,
        samples,
    })
}

fn truncate(value: &str, limit: usize) -> String {
    let mut result: String = value.chars().take(limit).collect();
    if value.chars().count() > limit {
        result.push('…');
    }
    result
}

const INSERT_CARD_SQL: &str = "INSERT INTO cards (
    id, excerpt, user_note, question, parent_id, sort_order, collapsed,
    due, review_state, surface_pdf, surface_mindmap, surface_review,
    created_at, updated_at, excerpt_image, link_aliases
) VALUES (?1, ?2, '', ?3, ?4, ?5, 0, ?6, 'new', 0, 1, ?7, ?6, ?6, NULL, '')";

pub fn import_anki_txt(state: &AppState, input: AnkiImportInput) -> Result<AnkiImportResult, String> {
    let canvas_id = input.canvas_id.trim().to_string();
    if canvas_id.is_empty() {
        return Err("请先选择目标画布".into());
    }
    let content = read_source(&input.source_path)?;
    let (all_notes, _) = extract_notes(&content)?;
    let selected: Vec<&AnkiNote> = match &input.deck_names {
        None => all_notes.iter().collect(),
        Some(names) => all_notes
            .iter()
            .filter(|note| names.contains(&note.deck))
            .collect(),
    };
    let timestamp = now();
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    if !canvases::canvas_exists(&transaction, &canvas_id)? {
        return Err(format!("画布 {canvas_id} 不存在，请先新建画布"));
    }

    let mut groups: HashMap<String, String> = HashMap::new();
    let mut group_count = 0_u32;
    let mut imported = 0_u32;
    let mut skipped = 0_u32;
    let mut index = 0_u32;

    for note in selected {
        // 去重范围是整个画布（不按分组）：两份参考文件是同一套卡的两种导出格式，
        // 先导入「仅正面」再导入「含答案」时不应该再长出一套空分组。
        let existing: Option<(String, String)> = transaction
            .query_row(
                "SELECT c.id, c.excerpt FROM cards c
                 JOIN mindmap_layout l ON l.card_id = c.id AND l.canvas_id = ?1
                 WHERE c.question = ?2 AND c.surface_review = 1
                 LIMIT 1",
                params![canvas_id, note.front],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some((existing_id, existing_answer)) = existing {
            // 只有正面的导出先导入时，后导入的带答案版本把答案与标签补齐。
            if existing_answer.trim().is_empty() && !note.back.trim().is_empty() {
                transaction
                    .execute(
                        "UPDATE cards SET excerpt = ?2, updated_at = ?3 WHERE id = ?1",
                        params![existing_id, note.back, timestamp],
                    )
                    .map_err(|error| error.to_string())?;
                for tag in &note.tags {
                    transaction
                        .execute(
                            "INSERT OR IGNORE INTO card_tags (card_id, tag, created_at) VALUES (?1, ?2, ?3)",
                            params![existing_id, tag, timestamp],
                        )
                        .map_err(|error| error.to_string())?;
                }
            }
            skipped += 1;
            continue;
        }

        let mut parent_id: Option<String> = None;
        let mut path_key = String::new();
        for (depth, name) in note.deck_path.iter().enumerate() {
            path_key = if path_key.is_empty() { name.clone() } else { format!("{path_key}::{name}") };
            if let Some(existing) = groups.get(&path_key) {
                parent_id = Some(existing.clone());
                continue;
            }
            // 同一画布里已有同名分组节点就复用，避免重复导入时树被复制。
            let found: Option<String> = transaction
                .query_row(
                    "SELECT c.id FROM cards c
                     JOIN mindmap_layout l ON l.card_id = c.id AND l.canvas_id = ?1
                     WHERE c.question = ?2 AND c.excerpt = '' AND c.user_note = ''
                       AND c.surface_review = 0 AND c.parent_id IS ?3
                     LIMIT 1",
                    params![canvas_id, name, parent_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            let group_id = if let Some(id) = found {
                id
            } else {
                let id = Uuid::new_v4().to_string();
                transaction
                    .execute(
                        INSERT_CARD_SQL,
                        params![id, "", name, parent_id, depth as i64, timestamp, 0],
                    )
                    .map_err(|error| error.to_string())?;
                transaction
                    .execute(
                        "INSERT INTO mindmap_layout (card_id, canvas_id, x, y, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![id, canvas_id, (depth as f64) * 360.0, 80.0 + (group_count as f64) * 240.0, timestamp],
                    )
                    .map_err(|error| error.to_string())?;
                group_count += 1;
                id
            };
            groups.insert(path_key.clone(), group_id.clone());
            parent_id = Some(group_id);
        }

        let card_id = Uuid::new_v4().to_string();
        transaction
            .execute(
                INSERT_CARD_SQL,
                params![card_id, note.back, note.front, parent_id, index as i64, timestamp, 1],
            )
            .map_err(|error| error.to_string())?;
        let column = index % 10;
        let row = index / 10;
        transaction
            .execute(
                "INSERT INTO mindmap_layout (card_id, canvas_id, x, y, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    card_id,
                    canvas_id,
                    360.0 + (note.deck_path.len() as f64) * 360.0 + (column as f64) * 340.0,
                    80.0 + (row as f64) * 220.0,
                    timestamp,
                ],
            )
            .map_err(|error| error.to_string())?;
        for tag in &note.tags {
            transaction
                .execute(
                    "INSERT OR IGNORE INTO card_tags (card_id, tag, created_at) VALUES (?1, ?2, ?3)",
                    params![card_id, tag, timestamp],
                )
                .map_err(|error| error.to_string())?;
        }
        imported += 1;
        index += 1;
    }

    canvases::sync_mindmap_surface(&transaction)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(AnkiImportResult { imported, groups: group_count, skipped, canvas_id })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::CreateMindmapCanvasInput;
    use crate::state::test_state;

    fn write_temp(content: &str) -> String {
        let path = std::env::temp_dir().join(format!("pdfnote-anki-{}.txt", Uuid::new_v4()));
        fs::write(&path, content).unwrap();
        path.to_string_lossy().to_string()
    }

    const STANDARD: &str = "#separator:tab\n#html:true\n#guid column:1\n#notetype column:2\n#deck column:3\n#tags column:6\n\
\"Qc#~bH@O95\"\t问答题（输入答案）+\t系统规划与管理师::001 第一章 信息化发展\t信息不是（）也不是（）\t物质；能力\t信息化发展 新教材\n\
guid2\t问答题（输入答案）+\t系统规划与管理师::002 第二章 信息技术发展\t信息系统的生命周期5小\t\"<span style=\"\"color: rgb(255, 255, 127);\"\">对象的处理模型</span>与<br>过程抽象\"\t新教材 生命周期\n";

    #[test]
    fn parses_standard_six_column_export() {
        let path = write_temp(STANDARD);
        let preview = preview_anki_txt(&path).unwrap();
        assert_eq!(preview.format, "anki-standard");
        assert_eq!(preview.total, 2);
        assert!(preview.has_answers);
        assert_eq!(preview.decks.len(), 2);
        assert_eq!(preview.samples[0].front, "信息不是（）也不是（）");
        let (notes, _) = extract_notes(&read_source(&path).unwrap()).unwrap();
        assert_eq!(notes[0].deck_path, vec!["系统规划与管理师", "001 第一章 信息化发展"]);
        assert_eq!(notes[0].back, "物质；能力");
        assert!(notes[0].tags.iter().any(|t| t == "信息化发展"));
        assert_eq!(notes[1].back, "对象的处理模型与\n过程抽象");
        assert!(notes[1].tags.iter().any(|t| t == "002 第二章 信息技术发展"));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn parses_front_only_multiline_export() {
        let content = "#separator:tab\n#html:true\n\"信息不是（）也不是（）\n\n\"\t\n\"信息的11项特征\n\n\"\t\n";
        let path = write_temp(content);
        let preview = preview_anki_txt(&path).unwrap();
        assert_eq!(preview.format, "anki-front-only");
        assert_eq!(preview.total, 2);
        assert!(!preview.has_answers);
        assert_eq!(preview.decks[0].name, UNGROUPED_DECK);
        let (notes, _) = extract_notes(&read_source(&path).unwrap()).unwrap();
        assert_eq!(notes[0].front, "信息不是（）也不是（）");
        assert!(notes[0].back.is_empty());
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn html_cleaning_keeps_text_and_decodes_entities() {
        let cleaned = clean_html(
            "<div>A&nbsp;&amp;&nbsp;B</div><p style=\"color:red\">C&lt;D</p><br>末行",
            true,
        );
        assert!(cleaned.contains("A & B"));
        assert!(cleaned.contains("C<D"));
        assert!(cleaned.contains("末行"));
        assert!(!cleaned.contains("<div>"));
        assert_eq!(clean_html("  原文  ", false), "原文");
    }

    #[test]
    fn import_builds_group_tree_and_is_idempotent() {
        let (_directory, state) = test_state();
        canvases::create_canvas(&state, CreateMindmapCanvasInput {
            id: Some("anki-canvas".into()), name: "Anki".into(), document_id: None,
        }).unwrap();
        let path = write_temp(STANDARD);
        let result = import_anki_txt(&state, AnkiImportInput {
            source_path: path.clone(), canvas_id: "anki-canvas".into(), deck_names: None,
        }).unwrap();
        assert_eq!(result.imported, 2);
        assert_eq!(result.groups, 3, "一个根分组 + 两个章节分组");
        assert_eq!(result.skipped, 0);

        let database = state.db().unwrap();
        let cards_in_canvas: i64 = database.query_row(
            "SELECT COUNT(*) FROM mindmap_layout WHERE canvas_id = 'anki-canvas'", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(cards_in_canvas, 5);
        let group_cards: i64 = database.query_row(
            "SELECT COUNT(*) FROM cards WHERE surface_review = 0", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(group_cards, 3);
        let tags: i64 = database.query_row(
            "SELECT COUNT(*) FROM card_tags", [], |row| row.get(0),
        ).unwrap();
        assert!(tags >= 4);
        let question_card: String = database.query_row(
            "SELECT excerpt FROM cards WHERE question = '信息不是（）也不是（）'", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(question_card, "物质；能力");
        drop(database);

        // 重复导入同文件到同一画布：全部命中去重。
        let again = import_anki_txt(&state, AnkiImportInput {
            source_path: path.clone(), canvas_id: "anki-canvas".into(), deck_names: None,
        }).unwrap();
        assert_eq!(again.imported, 0);
        assert_eq!(again.groups, 0);
        assert_eq!(again.skipped, 2);

        // 勾选单个牌组时只导入该牌组的卡片。
        canvases::create_canvas(&state, CreateMindmapCanvasInput {
            id: Some("anki-one".into()), name: "Anki 单章".into(), document_id: None,
        }).unwrap();
        let filtered = import_anki_txt(&state, AnkiImportInput {
            source_path: path.clone(),
            canvas_id: "anki-one".into(),
            deck_names: Some(vec!["系统规划与管理师::001 第一章 信息化发展".into()]),
        }).unwrap();
        assert_eq!(filtered.imported, 1);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn cross_format_import_enriches_answer_without_orphan_groups() {
        let (_directory, state) = test_state();
        canvases::create_canvas(&state, CreateMindmapCanvasInput {
            id: Some("mixed-canvas".into()), name: "混合导入".into(), document_id: None,
        }).unwrap();
        let front_only = write_temp("#separator:tab\n#html:true\n\"信息不是（）也不是（）\n\n\"\t\n");
        let with_answer = write_temp(STANDARD);
        let first = import_anki_txt(&state, AnkiImportInput {
            source_path: front_only.clone(), canvas_id: "mixed-canvas".into(), deck_names: None,
        }).unwrap();
        assert_eq!(first.imported, 1);
        let second = import_anki_txt(&state, AnkiImportInput {
            source_path: with_answer.clone(), canvas_id: "mixed-canvas".into(), deck_names: None,
        }).unwrap();
        assert_eq!(second.imported, 1, "只有第二张新题会被导入");
        assert_eq!(second.skipped, 1, "同题目的另一份导出被跳过");

        let database = state.db().unwrap();
        let answer: String = database.query_row(
            "SELECT excerpt FROM cards WHERE question = '信息不是（）也不是（）'", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(answer, "物质；能力", "仅正面导入的卡片被补齐答案");
        let review_cards: i64 = database.query_row(
            "SELECT COUNT(*) FROM cards WHERE surface_review = 1", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(review_cards, 2, "跨格式重复导入不产生重复问题卡");
        let groups: i64 = database.query_row(
            "SELECT COUNT(*) FROM cards WHERE surface_review = 0", [], |row| row.get(0),
        ).unwrap();
        assert_eq!(groups, 3, "未分组 + 根 + 有新卡的章节，跳过题的章节不建空组");
        drop(database);
        fs::remove_file(front_only).unwrap();
        fs::remove_file(with_answer).unwrap();
    }

    /// 可选集成测试：ANKI_FIXTURE_PATH 指向真实 AnkiDroid 导出 txt 时验证整份文件可解析。
    /// 参考文件不入库（体积大且含用户数据），因此未设置环境变量时直接跳过。
    #[test]
    fn parses_real_export_when_fixture_is_provided() {
        let Ok(path) = std::env::var("ANKI_FIXTURE_PATH") else { return };
        let preview = preview_anki_txt(&path).unwrap();
        assert!(preview.total > 0, "真实导出应解析出卡片：{path}");
        assert!(!preview.decks.is_empty());
        assert!(preview.samples.iter().all(|sample| !sample.front.trim().is_empty()));
        let (notes, _) = extract_notes(&read_source(&path).unwrap()).unwrap();
        assert_eq!(notes.len() as u32, preview.total);
        assert!(notes.iter().all(|note| !note.deck_path.is_empty()));
        eprintln!(
            "[anki-fixture] {path}: format={} total={} decks={} has_answers={}",
            preview.format, preview.total, preview.decks.len(), preview.has_answers,
        );
    }

    #[test]
    fn import_rejects_missing_canvas_and_bad_file() {
        let (_directory, state) = test_state();
        let path = write_temp(STANDARD);
        let error = import_anki_txt(&state, AnkiImportInput {
            source_path: path.clone(), canvas_id: "nope".into(), deck_names: None,
        }).unwrap_err();
        assert!(error.contains("画布"));
        assert!(preview_anki_txt("/tmp/pdfnote-anki-missing-file.txt").is_err());
        let empty = write_temp("#separator:tab\n\n");
        assert!(preview_anki_txt(&empty).is_err());
        fs::remove_file(empty).unwrap();
        fs::remove_file(path).unwrap();
    }
}
