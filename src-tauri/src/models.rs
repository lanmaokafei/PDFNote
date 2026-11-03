use chrono::{SecondsFormat, Utc};
use rusqlite::{params_from_iter, Connection, Error, Row};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NormalizedBBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl NormalizedBBox {
    pub fn validate(&self) -> Result<(), String> {
        let values = [self.x, self.y, self.width, self.height];
        if values.iter().any(|value| !value.is_finite()) {
            return Err("bbox 值必须是有限数".into());
        }
        if self.x < 0.0 || self.y < 0.0 || self.width <= 0.0 || self.height <= 0.0 {
            return Err("bbox 原点不能为负且尺寸必须为正".into());
        }
        if self.x + self.width > 1.000_001 || self.y + self.height > 1.000_001 {
            return Err("bbox 必须归一化到页面范围".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceRef {
    pub document_id: String,
    pub page: u32,
    pub bbox: NormalizedBBox,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Card {
    pub id: String,
    pub source_ref: Option<SourceRef>,
    pub excerpt: String,
    pub user_note: String,
    pub question: String,
    /// 标签按字母序返回，空数组表示没有标签。
    pub tags: Vec<String>,
    pub parent_id: Option<String>,
    pub sort_order: i64,
    pub collapsed: bool,
    pub stability: f64,
    pub difficulty: f64,
    pub elapsed_days: f64,
    pub scheduled_days: i64,
    pub learning_steps: i64,
    pub due: String,
    pub last_review: Option<String>,
    pub reps: i64,
    pub lapses: i64,
    pub review_state: String,
    pub surface_pdf: bool,
    pub surface_mindmap: bool,
    pub surface_review: bool,
    /// 选区截图（data URL）。扫描版 PDF 的公式或图像摘录随卡片存档。
    #[serde(default)]
    pub excerpt_image: Option<String>,
    /// 标题链接别名，分号分隔；为空时只用 question 作为关键词。
    #[serde(default)]
    pub link_aliases: String,
    pub created_at: String,
    pub updated_at: String,
}

pub const CARD_COLUMNS: &str = "id, document_id, page, bbox_x, bbox_y, bbox_width, bbox_height, excerpt, user_note, question, parent_id, sort_order, collapsed, stability, difficulty, elapsed_days, scheduled_days, learning_steps, due, last_review, reps, lapses, review_state, surface_pdf, surface_mindmap, surface_review, created_at, updated_at, excerpt_image, link_aliases";

pub fn card_from_row(row: &Row<'_>) -> Result<Card, Error> {
    let document_id: Option<String> = row.get(1)?;
    let page: Option<u32> = row.get(2)?;
    let source_ref = match (document_id, page) {
        (Some(document_id), Some(page)) => Some(SourceRef {
            document_id,
            page,
            bbox: NormalizedBBox {
                x: row.get(3)?,
                y: row.get(4)?,
                width: row.get(5)?,
                height: row.get(6)?,
            },
        }),
        _ => None,
    };

    Ok(Card {
        id: row.get(0)?,
        source_ref,
        excerpt: row.get(7)?,
        user_note: row.get(8)?,
        question: row.get(9)?,
        tags: Vec::new(),
        parent_id: row.get(10)?,
        sort_order: row.get(11)?,
        collapsed: row.get::<_, i64>(12)? != 0,
        stability: row.get(13)?,
        difficulty: row.get(14)?,
        elapsed_days: row.get(15)?,
        scheduled_days: row.get(16)?,
        learning_steps: row.get(17)?,
        due: row.get(18)?,
        last_review: row.get(19)?,
        reps: row.get(20)?,
        lapses: row.get(21)?,
        review_state: row.get(22)?,
        surface_pdf: row.get::<_, i64>(23)? != 0,
        surface_mindmap: row.get::<_, i64>(24)? != 0,
        surface_review: row.get::<_, i64>(25)? != 0,
        created_at: row.get(26)?,
        updated_at: row.get(27)?,
        excerpt_image: row.get(28)?,
        link_aliases: row.get(29)?,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Document {
    pub id: String,
    pub title: String,
    pub stored_path: String,
    pub original_path: Option<String>,
    pub content_hash: String,
    pub file_size: i64,
    pub page_count: i64,
    pub file_status: String,
    /// 上次阅读到的页码，重新打开文档时用于恢复位置。
    pub last_page: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// 批量补齐标签，避免在卡片列表里做 N+1 查询。
pub fn attach_tags(connection: &Connection, cards: &mut [Card]) -> Result<(), Error> {
    if cards.is_empty() {
        return Ok(());
    }
    let placeholders = vec!["?"; cards.len()].join(", ");
    let query = format!(
        "SELECT card_id, tag FROM card_tags WHERE card_id IN ({placeholders}) ORDER BY tag"
    );
    let mut statement = connection.prepare(&query)?;
    let rows = statement.query_map(params_from_iter(cards.iter().map(|card| &card.id)), |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut grouped: HashMap<String, Vec<String>> = HashMap::new();
    for row in rows {
        let (card_id, tag) = row?;
        grouped.entry(card_id).or_default().push(tag);
    }
    for card in cards.iter_mut() {
        if let Some(tags) = grouped.remove(&card.id) {
            card.tags = tags;
        }
    }
    Ok(())
}

pub const DOCUMENT_COLUMNS: &str = "id, title, stored_path, original_path, content_hash, file_size, page_count, file_status, created_at, updated_at, last_page";

pub fn document_from_row(row: &Row<'_>) -> Result<Document, Error> {
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
        last_page: row.get(10)?,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnnotationGeometry {
    pub rects: Vec<NormalizedBBox>,
}

impl AnnotationGeometry {
    pub fn validate(&self) -> Result<(), String> {
        if self.rects.is_empty() {
            return Err("标注需要至少一个矩形".into());
        }
        for rect in &self.rects {
            rect.validate()?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Annotation {
    pub id: String,
    pub card_id: String,
    pub kind: String,
    pub page: u32,
    pub geometry: AnnotationGeometry,
    #[serde(default = "default_json")]
    pub style: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

fn default_json() -> serde_json::Value {
    serde_json::json!({})
}

pub const ANNOTATION_COLUMNS: &str =
    "a.id, a.card_id, a.kind, a.page, a.geometry_json, a.style_json, a.created_at, a.updated_at";

pub fn annotation_from_row(row: &Row<'_>) -> Result<Annotation, Error> {
    Ok(Annotation {
        id: row.get(0)?,
        card_id: row.get(1)?,
        kind: row.get(2)?,
        page: row.get(3)?,
        geometry: serde_json::from_str(&row.get::<_, String>(4)?)
            .unwrap_or(AnnotationGeometry { rects: Vec::new() }),
        style: serde_json::from_str(&row.get::<_, String>(5)?).unwrap_or(serde_json::json!({})),
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

#[derive(Debug, Deserialize)]
pub struct AnnotationInput {
    pub kind: String,
    pub geometry: AnnotationGeometry,
    #[serde(default = "default_json")]
    pub style: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct CreateCardInput {
    pub source_ref: Option<SourceRef>,
    #[serde(default)]
    pub excerpt: String,
    #[serde(default)]
    pub user_note: String,
    #[serde(default)]
    pub question: String,
    pub parent_id: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
    pub annotation: Option<AnnotationInput>,
    #[serde(default)]
    pub excerpt_image: Option<String>,
    /// 标题链接别名（分号分隔），创建时可选。
    #[serde(default)]
    pub link_aliases: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateCardContentInput {
    pub id: String,
    pub excerpt: String,
    pub user_note: String,
    pub question: String,
    /// 标题链接别名（分号分隔）。旧前端不传时保留原值由 SQL 处理。
    #[serde(default)]
    pub link_aliases: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardLink {
    pub id: String,
    pub source_card_id: String,
    pub target_card_id: String,
    pub label: String,
    pub created_at: String,
}

pub const CARD_LINK_COLUMNS: &str = "id, source_card_id, target_card_id, label, created_at";

pub fn link_from_row(row: &Row<'_>) -> Result<CardLink, Error> {
    Ok(CardLink {
        id: row.get(0)?,
        source_card_id: row.get(1)?,
        target_card_id: row.get(2)?,
        label: row.get(3)?,
        created_at: row.get(4)?,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageInk {
    pub id: String,
    pub document_id: String,
    pub page: u32,
    pub bbox: NormalizedBBox,
    pub style: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

pub const PAGE_INK_COLUMNS: &str =
    "id, document_id, page, bbox_x, bbox_y, bbox_width, bbox_height, style_json, created_at, updated_at";

pub fn ink_from_row(row: &Row<'_>) -> Result<PageInk, Error> {
    Ok(PageInk {
        id: row.get(0)?,
        document_id: row.get(1)?,
        page: row.get(2)?,
        bbox: NormalizedBBox {
            x: row.get(3)?,
            y: row.get(4)?,
            width: row.get(5)?,
            height: row.get(6)?,
        },
        style: serde_json::from_str(&row.get::<_, String>(7)?).unwrap_or(serde_json::json!({})),
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MindmapLayout {
    pub card_id: String,
    pub canvas_id: String,
    pub x: f64,
    pub y: f64,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct MindmapLayoutInput {
    pub card_id: String,
    #[serde(default = "default_canvas")]
    pub canvas_id: String,
    pub x: f64,
    pub y: f64,
}

fn default_canvas() -> String {
    "main".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewInput {
    pub card_id: String,
    pub client_event_id: String,
    pub session_id: String,
    pub rating: i64,
    pub source: String,
    pub scheduler_version: String,
    pub expected_updated_at: String,
    pub reviewed_at: String,
    pub stability: f64,
    pub difficulty: f64,
    pub elapsed_days: f64,
    pub scheduled_days: i64,
    pub learning_steps: i64,
    pub due: String,
    pub reps: i64,
    pub lapses: i64,
    pub review_state: String,
}

#[derive(Debug, Serialize)]
pub struct DailyReviewStats {
    pub day: String,
    pub reviews: i64,
    pub correct: i64,
}

#[derive(Debug, Serialize)]
pub struct ReviewStats {
    pub due_now: i64,
    pub completed_today: i64,
    pub correct_today: i64,
    pub backlog: i64,
    pub daily: Vec<DailyReviewStats>,
}

#[derive(Debug, Serialize)]
pub struct BootstrapStatus {
    pub database_ready: bool,
    pub schema_version: u32,
    pub document_count: i64,
    pub card_count: i64,
}

#[derive(Debug, Serialize)]
pub struct BackupResult {
    pub path: String,
    pub documents: i64,
    pub cards: i64,
}
