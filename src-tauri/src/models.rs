use rusqlite::{Error, Row};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct SourceRef {
    pub document_id: String,
    pub page: u32,
    pub bbox: NormalizedBBox,
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
            return Err("bbox values must be finite".into());
        }
        if self.x < 0.0 || self.y < 0.0 || self.width <= 0.0 || self.height <= 0.0 {
            return Err("bbox must have a non-negative origin and positive size".into());
        }
        if self.x + self.width > 1.000001 || self.y + self.height > 1.000001 {
            return Err("bbox must be normalized to the page bounds".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Card {
    pub id: String,
    pub source_ref: Option<SourceRef>,
    pub excerpt: String,
    pub user_note: String,
    pub question: String,
    pub parent_id: Option<String>,
    pub sort_order: i64,
    pub collapsed: bool,
    pub stability: f64,
    pub difficulty: f64,
    pub due: String,
    pub last_review: Option<String>,
    pub reps: i64,
    pub lapses: i64,
    pub review_state: String,
    pub surface_pdf: bool,
    pub surface_mindmap: bool,
    pub surface_review: bool,
    pub created_at: String,
    pub updated_at: String,
}

pub const CARD_COLUMNS: &str = "id, document_id, page, bbox_x, bbox_y, bbox_width, bbox_height, excerpt, user_note, question, parent_id, sort_order, collapsed, stability, difficulty, due, last_review, reps, lapses, review_state, surface_pdf, surface_mindmap, surface_review, created_at, updated_at";

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
        parent_id: row.get(10)?,
        sort_order: row.get(11)?,
        collapsed: row.get::<_, i64>(12)? != 0,
        stability: row.get(13)?,
        difficulty: row.get(14)?,
        due: row.get(15)?,
        last_review: row.get(16)?,
        reps: row.get(17)?,
        lapses: row.get(18)?,
        review_state: row.get(19)?,
        surface_pdf: row.get::<_, i64>(20)? != 0,
        surface_mindmap: row.get::<_, i64>(21)? != 0,
        surface_review: row.get::<_, i64>(22)? != 0,
        created_at: row.get(23)?,
        updated_at: row.get(24)?,
    })
}

#[derive(Debug, Deserialize)]
pub struct AnnotationInput {
    pub kind: String,
    pub geometry: serde_json::Value,
    #[serde(default = "default_style")]
    pub style: serde_json::Value,
}

fn default_style() -> serde_json::Value {
    serde_json::json!({})
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
}

#[derive(Debug, Serialize)]
pub struct BootstrapStatus {
    pub database_ready: bool,
    pub schema_version: u32,
    pub document_count: i64,
    pub card_count: i64,
}
