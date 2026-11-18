use crate::{
    cards::get_card,
    models::{card_from_row, now, Card, DailyReviewStats, ReviewInput, ReviewStats, CARD_COLUMNS},
    state::AppState,
};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::Serialize;
use rusqlite::{params, OptionalExtension};
use uuid::Uuid;

pub fn list_due_cards(
    state: &AppState,
    now: String,
    limit: Option<u32>,
    card_ids: Option<Vec<String>>,
) -> Result<Vec<Card>, String> {
    DateTime::parse_from_rfc3339(&now).map_err(|_| "now must be an RFC 3339 timestamp")?;
    // Some(ids) = 只复习这一组卡（学习报告的「卡住清单」）；Some(空) 表示没有可复习的卡。
    let filtered = card_ids.map(|ids| {
        let mut seen = std::collections::HashSet::new();
        ids.into_iter()
            .filter(|id| !id.is_empty() && seen.insert(id.clone()))
            .take(500)
            .collect::<Vec<_>>()
    });
    if matches!(&filtered, Some(ids) if ids.is_empty()) {
        return Ok(Vec::new());
    }
    let database = state.db()?;
    let mut query = format!(
        "SELECT {CARD_COLUMNS} FROM cards
         WHERE surface_review = 1 AND due <= ?1
           AND NOT EXISTS (SELECT 1 FROM card_trash t WHERE t.card_id = cards.id)
           AND NOT EXISTS (SELECT 1 FROM document_trash d WHERE d.document_id = cards.document_id)"
    );
    if let Some(ids) = &filtered {
        let placeholders = vec!["?"; ids.len()].join(", ");
        query.push_str(&format!(" AND id IN ({placeholders})"));
    }
    let limit_index = filtered.as_ref().map(|ids| ids.len()).unwrap_or(0) + 2;
    query.push_str(&format!(" ORDER BY due, id LIMIT ?{limit_index}"));

    let mut values: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(now.clone())];
    if let Some(ids) = &filtered {
        for id in ids {
            values.push(Box::new(id.clone()));
        }
    }
    values.push(Box::new(limit.unwrap_or(200).clamp(1, 500)));

    let mut statement = database
        .prepare(&query)
        .map_err(|error| error.to_string())?;
    let mut cards = statement
        .query_map(
            rusqlite::params_from_iter(values.iter().map(|value| value.as_ref())),
            card_from_row,
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    crate::models::attach_tags(&database, &mut cards).map_err(|error| error.to_string())?;
    Ok(cards)
}

/// 撤销一次评分：把卡片调度字段恢复成评分前，删掉这条日志，并回退当天统计。
///
/// 只允许撤销该卡片**最近一次**评分——否则会覆盖之后的新记录。
pub fn revert_review(state: &AppState, client_event_id: String) -> Result<Card, String> {
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;
    let log: Option<(String, i64, String, Option<f64>, Option<f64>, Option<f64>, Option<f64>,
        Option<i64>, Option<i64>, Option<i64>, Option<String>, String, String, String)> = transaction
        .query_row(
            "SELECT card_id, rating, reviewed_at, previous_stability, previous_difficulty,
                    previous_elapsed_days, previous_scheduled_days, previous_learning_steps,
                    previous_reps, previous_lapses, previous_last_review, previous_state,
                    previous_due, id
             FROM review_logs WHERE client_event_id = ?1",
            params![client_event_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?,
                row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?, row.get(11)?,
                row.get(12)?, row.get(13)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((card_id, rating, reviewed_at, stability, difficulty, elapsed_days, scheduled_days,
        learning_steps, reps, lapses, last_review, previous_state, previous_due, log_id)) = log else {
        return Err("这条评分记录不存在（可能已经撤销过）".into());
    };
    let stability = stability.ok_or("这条评分记录来自旧版本，缺少评分前状态，无法撤销")?;
    let difficulty = difficulty.ok_or("这条评分记录来自旧版本，缺少评分前状态，无法撤销")?;

    let newer: i64 = transaction
        .query_row(
            "SELECT COUNT(*) FROM review_logs
             WHERE card_id = ?1 AND id <> ?2
               AND (reviewed_at > ?3 OR (reviewed_at = ?3 AND id > ?2))",
            params![card_id, log_id, reviewed_at],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if newer > 0 {
        return Err("这张卡之后又有新的评分，撤销会覆盖更新的记录".into());
    }

    transaction
        .execute(
            "UPDATE cards SET stability = ?1, difficulty = ?2, elapsed_days = ?3,
                scheduled_days = ?4, learning_steps = ?5, reps = ?6, lapses = ?7,
                last_review = ?8, review_state = ?9, due = ?10, updated_at = ?11
             WHERE id = ?12",
            params![
                stability,
                difficulty,
                elapsed_days.unwrap_or(0.0),
                scheduled_days.unwrap_or(0.0),
                learning_steps.unwrap_or(0),
                reps.unwrap_or(0),
                lapses.unwrap_or(0),
                last_review,
                previous_state,
                previous_due,
                now(),
                card_id,
            ],
        )
        .map_err(|error| error.to_string())?;
    transaction
        .execute("DELETE FROM review_logs WHERE id = ?1", params![log_id])
        .map_err(|error| error.to_string())?;
    // 回退物化统计（按日志所在本地日期），不删行，只把计数减回去。
    let day = local_day(&reviewed_at)?;
    transaction
        .execute(
            "UPDATE review_daily SET reviews = MAX(0, reviews - 1),
                correct = MAX(0, correct - CASE WHEN ?2 >= 3 THEN 1 ELSE 0 END)
             WHERE day = ?1",
            params![day, rating],
        )
        .map_err(|error| error.to_string())?;
    let card = get_card(&transaction, &card_id)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(card)
}

fn validate_review(input: &ReviewInput) -> Result<(), String> {
    if input.client_event_id.is_empty() {
        return Err("client_event_id cannot be empty".into());
    }
    if !(1..=4).contains(&input.rating) {
        return Err("rating must be between 1 and 4".into());
    }
    if !["flashcard", "document_recall", "mindmap_recall"].contains(&input.source.as_str()) {
        return Err("unsupported review source".into());
    }
    if !["new", "learning", "review", "relearning"].contains(&input.review_state.as_str()) {
        return Err("unsupported review state".into());
    }
    if [input.stability, input.difficulty, input.elapsed_days]
        .iter()
        .any(|value| !value.is_finite() || *value < 0.0)
    {
        return Err("review scheduling values must be finite and non-negative".into());
    }
    if input.scheduled_days < 0 || input.learning_steps < 0 || input.reps < 0 || input.lapses < 0 {
        return Err("review counters cannot be negative".into());
    }
    DateTime::parse_from_rfc3339(&input.reviewed_at)
        .map_err(|_| "reviewed_at must be an RFC 3339 timestamp")?;
    DateTime::parse_from_rfc3339(&input.due).map_err(|_| "due must be an RFC 3339 timestamp")?;
    Ok(())
}

fn next_timestamp(previous: &str) -> String {
    let timestamp = now();
    if timestamp != previous {
        return timestamp;
    }
    DateTime::parse_from_rfc3339(previous)
        .ok()
        .and_then(|value| {
            value
                .checked_add_signed(Duration::milliseconds(1))
                .map(|value| {
                    value
                        .with_timezone(&Utc)
                        .to_rfc3339_opts(SecondsFormat::Millis, true)
                })
        })
        .unwrap_or(timestamp)
}

pub fn record_review(state: &AppState, input: ReviewInput) -> Result<Card, String> {
    validate_review(&input)?;
    let payload = serde_json::to_string(&input).map_err(|error| error.to_string())?;
    let mut database = state.db()?;
    let transaction = database.transaction().map_err(|error| error.to_string())?;

    let duplicate: Option<(String, String)> = transaction
        .query_row(
            "SELECT card_id, payload_json FROM review_logs WHERE client_event_id = ?1",
            params![input.client_event_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some((card_id, existing_payload)) = duplicate {
        if card_id != input.card_id || existing_payload != payload {
            return Err("client_event_id was already used for a different review".into());
        }
        let card = get_card(&transaction, &card_id)?;
        transaction.commit().map_err(|error| error.to_string())?;
        return Ok(card);
    }

    let previous = get_card(&transaction, &input.card_id)?;
    if previous.updated_at != input.expected_updated_at {
        return Err("card was modified by another operation; reload and retry the review".into());
    }
    let updated_at = next_timestamp(&previous.updated_at);
    let affected = transaction
        .execute(
            "UPDATE cards SET stability = ?1, difficulty = ?2, elapsed_days = ?3,
             scheduled_days = ?4, learning_steps = ?5, due = ?6, last_review = ?7,
             reps = ?8, lapses = ?9, review_state = ?10, updated_at = ?11
             WHERE id = ?12 AND updated_at = ?13",
            params![
                input.stability,
                input.difficulty,
                input.elapsed_days,
                input.scheduled_days,
                input.learning_steps,
                input.due,
                input.reviewed_at,
                input.reps,
                input.lapses,
                input.review_state,
                updated_at,
                input.card_id,
                input.expected_updated_at,
            ],
        )
        .map_err(|error| error.to_string())?;
    if affected != 1 {
        return Err("card was modified by another operation; reload and retry the review".into());
    }
    transaction
        .execute(
            "INSERT INTO review_logs (
                id, card_id, client_event_id, session_id, rating, source,
                previous_state, previous_due, new_due, stability, difficulty,
                elapsed_days, scheduler_version, reviewed_at, scheduled_days,
                learning_steps, reps, lapses, new_state, payload_json,
                previous_stability, previous_difficulty, previous_elapsed_days,
                previous_scheduled_days, previous_learning_steps, previous_reps,
                previous_lapses, previous_last_review
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20,
                ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28
             )",
            params![
                Uuid::new_v4().to_string(),
                input.card_id,
                input.client_event_id,
                input.session_id,
                input.rating,
                input.source,
                previous.review_state,
                previous.due,
                input.due,
                input.stability,
                input.difficulty,
                input.elapsed_days,
                input.scheduler_version,
                input.reviewed_at,
                input.scheduled_days,
                input.learning_steps,
                input.reps,
                input.lapses,
                input.review_state,
                payload,
                previous.stability,
                previous.difficulty,
                previous.elapsed_days,
                previous.scheduled_days,
                previous.learning_steps,
                previous.reps,
                previous.lapses,
                previous.last_review,
            ],
        )
        .map_err(|error| error.to_string())?;
    // 物化统计：按本地日期累加，读统计时只查这张小表（见 get_review_stats）。
    transaction
        .execute(
            "INSERT INTO review_daily (day, reviews, correct, updated_at)
             VALUES (?1, 1, CASE WHEN ?2 >= 3 THEN 1 ELSE 0 END, ?3)
             ON CONFLICT(day) DO UPDATE SET
                reviews = reviews + 1,
                correct = correct + excluded.correct,
                updated_at = excluded.updated_at",
            params![local_day(&input.reviewed_at)?, input.rating, input.reviewed_at],
        )
        .map_err(|error| error.to_string())?;
    let card = get_card(&transaction, &input.card_id)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(card)
}

/// 时间戳 → 本机时区的日期键（`YYYY-MM-DD`）。统计一律按本地日期分桶，
/// 否则 UTC+8 的凌晨复习会被算到前一天。
fn local_day(iso: &str) -> Result<String, String> {
    let parsed =
        DateTime::parse_from_rfc3339(iso).map_err(|_| "timestamp must be RFC 3339")?;
    Ok(parsed
        .with_timezone(&chrono::Local)
        .format("%Y-%m-%d")
        .to_string())
}

/// 由 review_logs 重建物化统计表：导入备份、清空数据后调用。
pub fn rebuild_review_daily(connection: &rusqlite::Connection) -> Result<(), String> {
    connection
        .execute("DELETE FROM review_daily", [])
        .map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT INTO review_daily (day, reviews, correct, updated_at)
             SELECT date(reviewed_at, 'localtime'), COUNT(*),
                    COALESCE(SUM(CASE WHEN rating >= 3 THEN 1 ELSE 0 END), 0),
                    MAX(reviewed_at)
             FROM review_logs
             WHERE reviewed_at IS NOT NULL AND reviewed_at <> ''
               AND date(reviewed_at, 'localtime') IS NOT NULL
             GROUP BY date(reviewed_at, 'localtime')",
            [],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn get_review_stats(state: &AppState, day_start: String) -> Result<ReviewStats, String> {
    DateTime::parse_from_rfc3339(&day_start)
        .map_err(|_| "dayStart must be an RFC 3339 timestamp")?;
    let database = state.db()?;
    let current_time = now();
    let day = local_day(&day_start)?;
    let trend_start = (chrono::NaiveDate::parse_from_str(&day, "%Y-%m-%d")
        .map_err(|_| "dayStart must be an RFC 3339 timestamp")?
        - Duration::days(13))
    .format("%Y-%m-%d")
    .to_string();
    let due_now = database
        .query_row(
            "SELECT COUNT(*) FROM cards WHERE surface_review = 1 AND due <= ?1
               AND NOT EXISTS (SELECT 1 FROM card_trash t WHERE t.card_id = cards.id)
               AND NOT EXISTS (SELECT 1 FROM document_trash d WHERE d.document_id = cards.document_id)",
            params![current_time],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let backlog = database
        .query_row(
            "SELECT COUNT(*) FROM cards WHERE surface_review = 1 AND due < ?1
               AND NOT EXISTS (SELECT 1 FROM card_trash t WHERE t.card_id = cards.id)
               AND NOT EXISTS (SELECT 1 FROM document_trash d WHERE d.document_id = cards.document_id)",
            params![day_start],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    // 今日与趋势都读物化表；review_logs 只在导入备份后用来重建它。
    let (completed_today, correct_today): (i64, i64) = database
        .query_row(
            "SELECT COALESCE(reviews, 0), COALESCE(correct, 0) FROM review_daily WHERE day = ?1",
            params![day],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .unwrap_or((0, 0));
    let mut statement = database
        .prepare(
            "SELECT day, reviews, correct FROM review_daily
             WHERE day >= ?1 AND day <= ?2 ORDER BY day",
        )
        .map_err(|error| error.to_string())?;
    let daily = statement
        .query_map(params![trend_start, day], |row| {
            Ok(DailyReviewStats {
                day: row.get(0)?,
                reviews: row.get(1)?,
                correct: row.get(2)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(ReviewStats {
        due_now,
        completed_today,
        correct_today,
        backlog,
        daily,
    })
}

/// 跨书学习汇总：一段时间内写了多少卡、复习了多少次，并按书拆开。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyBookStat {
    pub document_id: Option<String>,
    pub title: String,
    pub cards_written: i64,
    pub reviews: i64,
    pub reviewed_cards: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudyOverview {
    pub cards_written: i64,
    pub reviews: i64,
    pub reviewed_cards: i64,
    pub correct: i64,
    pub books: Vec<StudyBookStat>,
}

/// 跨书汇总：只统计「有正文内容」的卡片（排除目录骨架这类只有标题的节点），
/// 回收站里的卡片不计入；按复习次数从多到少排序。
pub fn get_study_overview(state: &AppState, since: &str) -> Result<StudyOverview, String> {
    DateTime::parse_from_rfc3339(since).map_err(|_| "since must be an RFC 3339 timestamp")?;
    let database = state.db()?;
    let mut written_statement = database
        .prepare(
            "SELECT c.document_id, COALESCE(d.title, '未关联文档') AS title,
                    SUM(CASE WHEN c.created_at >= ?1
                              AND (TRIM(c.excerpt) <> '' OR TRIM(c.user_note) <> '')
                             THEN 1 ELSE 0 END) AS written
             FROM cards c LEFT JOIN documents d ON d.id = c.document_id
             WHERE NOT EXISTS (SELECT 1 FROM card_trash t WHERE t.card_id = c.id)
               AND NOT EXISTS (SELECT 1 FROM document_trash dt WHERE dt.document_id = c.document_id)
             GROUP BY c.document_id, d.title",
        )
        .map_err(|error| error.to_string())?;
    let written = written_statement
        .query_map(params![since], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    let mut review_statement = database
        .prepare(
            "SELECT c.document_id, COUNT(*), COUNT(DISTINCT r.card_id),
                    COALESCE(SUM(CASE WHEN r.rating >= 3 THEN 1 ELSE 0 END), 0)
             FROM review_logs r JOIN cards c ON c.id = r.card_id
             WHERE r.reviewed_at >= ?1
               AND NOT EXISTS (SELECT 1 FROM card_trash t WHERE t.card_id = c.id)
               AND NOT EXISTS (SELECT 1 FROM document_trash dt WHERE dt.document_id = c.document_id)
             GROUP BY c.document_id",
        )
        .map_err(|error| error.to_string())?;
    let reviews = review_statement
        .query_map(params![since], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    let mut books: Vec<StudyBookStat> = Vec::new();
    for (document_id, title, cards_written) in written {
        books.push(StudyBookStat {
            document_id,
            title,
            cards_written,
            reviews: 0,
            reviewed_cards: 0,
        });
    }
    let mut total_reviews = 0;
    let mut total_reviewed = 0;
    let mut total_correct = 0;
    for (document_id, review_count, reviewed_cards, correct) in reviews {
        total_reviews += review_count;
        total_reviewed += reviewed_cards;
        total_correct += correct;
        match books.iter_mut().find(|book| book.document_id == document_id) {
            Some(book) => {
                book.reviews = review_count;
                book.reviewed_cards = reviewed_cards;
            }
            None => books.push(StudyBookStat {
                document_id,
                title: "未关联文档".into(),
                cards_written: 0,
                reviews: review_count,
                reviewed_cards,
            }),
        }
    }
    books.retain(|book| book.cards_written > 0 || book.reviews > 0);
    books.sort_by(|a, b| {
        b.reviews
            .cmp(&a.reviews)
            .then(b.cards_written.cmp(&a.cards_written))
            .then(a.title.cmp(&b.title))
    });
    Ok(StudyOverview {
        cards_written: books.iter().map(|book| book.cards_written).sum(),
        reviews: total_reviews,
        reviewed_cards: total_reviewed,
        correct: total_correct,
        books,
    })
}

/// 某张卡在一段时间内的复习明细（学习报告用）：总次数 + 四档评分分布。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardReviewStat {
    pub card_id: String,
    pub reviews: i64,
    pub again: i64,
    pub hard: i64,
    pub good: i64,
    pub easy: i64,
    pub last_reviewed_at: String,
}

pub fn get_card_review_stats(state: &AppState, since: &str) -> Result<Vec<CardReviewStat>, String> {
    DateTime::parse_from_rfc3339(since).map_err(|_| "since must be an RFC 3339 timestamp")?;
    let database = state.db()?;
    let mut statement = database
        .prepare(
            "SELECT card_id, COUNT(*),
                    COALESCE(SUM(rating = 1), 0), COALESCE(SUM(rating = 2), 0),
                    COALESCE(SUM(rating = 3), 0), COALESCE(SUM(rating = 4), 0),
                    MAX(reviewed_at)
             FROM review_logs
             WHERE reviewed_at >= ?1
             GROUP BY card_id
             ORDER BY COUNT(*) DESC, card_id",
        )
        .map_err(|error| error.to_string())?;
    let stats = statement
        .query_map(params![since], |row| {
            Ok(CardReviewStat {
                card_id: row.get(0)?,
                reviews: row.get(1)?,
                again: row.get(2)?,
                hard: row.get(3)?,
                good: row.get(4)?,
                easy: row.get(5)?,
                last_reviewed_at: row.get(6)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{cards::create_card, models::CreateCardInput, state::test_state};

    fn review(card: &Card, event: &str) -> ReviewInput {
        ReviewInput {
            card_id: card.id.clone(),
            client_event_id: event.into(),
            session_id: "session".into(),
            rating: 3,
            source: "flashcard".into(),
            scheduler_version: "test".into(),
            expected_updated_at: card.updated_at.clone(),
            reviewed_at: "2026-01-01T00:00:00.000Z".into(),
            stability: 2.0,
            difficulty: 4.0,
            elapsed_days: 1.0,
            scheduled_days: 2,
            learning_steps: 0,
            due: "2026-01-03T00:00:00.000Z".into(),
            reps: 1,
            lapses: 0,
            review_state: "review".into(),
        }
    }

    #[test]
    fn review_is_transactional_and_idempotent() {
        let (_directory, state) = test_state();
        let card = create_card(
            &state,
            CreateCardInput {
                source_ref: None,
                excerpt: "excerpt".into(),
                user_note: String::new(),
                question: String::new(),
                parent_id: None,
                sort_order: 0,
                annotation: None,
                excerpt_image: None,
                link_aliases: None,
                canvas_id: None,
                x: None,
                y: None,
            },
        )
        .unwrap();
        let input = review(&card, "event-1");
        let reviewed = record_review(&state, input.clone()).unwrap();
        assert_eq!(reviewed.scheduled_days, 2);
        let retried = record_review(&state, input.clone()).unwrap();
        assert_eq!(retried.updated_at, reviewed.updated_at);
        let logs: i64 = state
            .db()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM review_logs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(logs, 1);

        let mut stale = review(&card, "event-2");
        stale.expected_updated_at = card.updated_at;
        assert!(record_review(&state, stale)
            .unwrap_err()
            .contains("modified"));
        let logs: i64 = state
            .db()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM review_logs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(logs, 1);
    }

    #[test]
    fn due_cards_can_be_filtered_by_card_ids() {
        let (_directory, state) = test_state();
        let make = |text: &str| {
            create_card(
                &state,
                CreateCardInput {
                    source_ref: None,
                    excerpt: text.into(),
                    user_note: String::new(),
                    question: String::new(),
                    parent_id: None,
                    sort_order: 0,
                    annotation: None,
                    excerpt_image: None,
                    link_aliases: None,
                    canvas_id: None,
                    x: None,
                    y: None,
                },
            )
            .unwrap()
        };
        let first = make("第一张");
        let _second = make("第二张");
        let now = "2030-01-01T00:00:00.000Z".to_string();

        assert_eq!(list_due_cards(&state, now.clone(), None, None).unwrap().len(), 2);

        let only = list_due_cards(&state, now.clone(), None, Some(vec![first.id.clone(), first.id.clone()])).unwrap();
        assert_eq!(only.len(), 1, "重复 id 只算一次");
        assert_eq!(only[0].id, first.id);

        assert!(list_due_cards(&state, now, None, Some(Vec::new())).unwrap().is_empty(), "空集合表示没有卡可复习");
    }

    fn make_card(state: &AppState, excerpt: &str) -> Card {
        create_card(
            state,
            CreateCardInput {
                source_ref: None,
                excerpt: excerpt.into(),
                user_note: String::new(),
                question: String::new(),
                parent_id: None,
                sort_order: 0,
                annotation: None,
                excerpt_image: None,
                link_aliases: None,
                canvas_id: None,
                x: None,
                y: None,
            },
        )
        .unwrap()
    }

    fn local_midnight_iso() -> String {
        let today = chrono::Local::now().date_naive();
        today
            .and_hms_opt(0, 0, 0)
            .unwrap()
            .and_local_timezone(chrono::Local)
            .single()
            .unwrap()
            .to_rfc3339()
    }

    #[test]
    fn reverting_a_review_restores_the_card_and_logs() {
        let (_directory, state) = test_state();
        let card = make_card(&state, "撤销评分");
        let before = {
            let database = state.db().unwrap();
            get_card(&database, &card.id).unwrap()
        };
        let mut input = review(&before, "revert-1");
        input.rating = 1;
        input.reviewed_at = chrono::Local::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        let day = local_day(&input.reviewed_at).unwrap();
        let after = record_review(&state, input).unwrap();
        assert_ne!(after.stability, before.stability);
        let logged: i64 = state
            .db()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM review_logs", [], |row| row.get(0))
            .unwrap();
        assert_eq!(logged, 1);

        let restored = revert_review(&state, "revert-1".into()).unwrap();
        assert_eq!(restored.stability, before.stability);
        assert_eq!(restored.difficulty, before.difficulty);
        assert_eq!(restored.due, before.due);
        assert_eq!(restored.reps, before.reps);
        assert_eq!(restored.review_state, "new");
        let (logs, reviews): (i64, i64) = state
            .db()
            .unwrap()
            .query_row(
                "SELECT (SELECT COUNT(*) FROM review_logs),
                        (SELECT COALESCE(SUM(reviews), 0) FROM review_daily WHERE day = ?1)",
                params![day],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!((logs, reviews), (0, 0), "日志与当天统计都要回退");

        assert!(revert_review(&state, "revert-1".into()).is_err(), "同一条日志不能撤销两次");
    }

    #[test]
    fn reverting_requires_the_latest_review() {
        let (_directory, state) = test_state();
        let card = make_card(&state, "覆盖保护");
        let current = {
            let database = state.db().unwrap();
            get_card(&database, &card.id).unwrap()
        };
        let mut first = review(&current, "older");
        first.reviewed_at = "2026-03-01T00:00:00.000Z".into();
        record_review(&state, first).unwrap();
        let second_base = {
            let database = state.db().unwrap();
            get_card(&database, &card.id).unwrap()
        };
        let mut second = review(&second_base, "newer");
        second.reviewed_at = "2026-03-02T00:00:00.000Z".into();
        record_review(&state, second).unwrap();

        let error = revert_review(&state, "older".into()).unwrap_err();
        assert!(error.contains("新的评分"), "应拦住旧记录，实际：{error}");
        assert!(revert_review(&state, "newer".into()).is_ok(), "最近一次应可撤销");
    }

    #[test]
    fn review_stats_read_materialized_days() {
        let (_directory, state) = test_state();
        let card = make_card(&state, "物化统计");
        let day_start = local_midnight_iso();
        let stats = get_review_stats(&state, day_start.clone()).unwrap();
        assert_eq!((stats.completed_today, stats.correct_today), (0, 0));

        let current = {
            let database = state.db().unwrap();
            get_card(&database, &card.id).unwrap()
        };
        let mut input = review(&current, "materialized-1");
        input.rating = 4;
        input.reviewed_at = chrono::Local::now().to_rfc3339_opts(SecondsFormat::Millis, true);
        record_review(&state, input).unwrap();

        let stats = get_review_stats(&state, day_start).unwrap();
        assert_eq!((stats.completed_today, stats.correct_today), (1, 1));
        assert_eq!(stats.daily.len(), 1);
        assert_eq!(stats.daily[0].reviews, 1);
        assert_eq!(stats.daily[0].correct, 1);
    }

    #[test]
    fn trashed_cards_leave_queue_and_stats() {
        let (_directory, state) = test_state();
        let card = make_card(&state, "回收站卡片");
        let now = "2030-01-01T00:00:00.000Z".to_string();
        assert_eq!(list_due_cards(&state, now.clone(), None, None).unwrap().len(), 1);

        crate::cards::delete_card(&state, card.id.clone()).unwrap();
        assert!(list_due_cards(&state, now.clone(), None, None).unwrap().is_empty(), "回收站里的卡片不该出现在复习队列");
        let stats = get_review_stats(&state, now).unwrap();
        assert_eq!(stats.due_now, 0);
        assert_eq!(stats.backlog, 0, "回收站里的卡片不算积压");
    }

    #[test]
    fn study_overview_aggregates_across_books() {
        let (_directory, state) = test_state();
        let first = make_card(&state, "第一本书的卡");
        let second = make_card(&state, "第二本书的卡");
        // 只有标题的骨架节点不算「写卡」。
        create_card(
            &state,
            CreateCardInput {
                source_ref: None,
                excerpt: String::new(),
                user_note: String::new(),
                question: "第一章 绪论".into(),
                parent_id: None,
                sort_order: 0,
                annotation: None,
                excerpt_image: None,
                link_aliases: None,
                canvas_id: None,
                x: None,
                y: None,
            },
        )
        .unwrap();

        let current = {
            let database = state.db().unwrap();
            get_card(&database, &first.id).unwrap()
        };
        let mut input = review(&current, "overview-1");
        input.reviewed_at = "2030-01-01T00:00:00.000Z".into();
        record_review(&state, input).unwrap();

        let overview = get_study_overview(&state, "2020-01-01T00:00:00.000Z").unwrap();
        assert_eq!(overview.cards_written, 2, "骨架节点不算写卡");
        assert_eq!((overview.reviews, overview.reviewed_cards, overview.correct), (1, 1, 1));
        assert_eq!(overview.books.len(), 1, "没有关联文档的卡片归到同一组");
        assert_eq!(overview.books[0].title, "未关联文档");

        // 回收站里的卡片不参与汇总。
        crate::cards::delete_card(&state, second.id).unwrap();
        let overview = get_study_overview(&state, "2020-01-01T00:00:00.000Z").unwrap();
        assert_eq!(overview.cards_written, 1);
    }

    #[test]
    fn card_review_stats_group_by_rating_and_respect_since() {
        let (_directory, state) = test_state();
        let card = create_card(
            &state,
            CreateCardInput {
                source_ref: None,
                excerpt: "excerpt".into(),
                user_note: String::new(),
                question: String::new(),
                parent_id: None,
                sort_order: 0,
                annotation: None,
                excerpt_image: None,
                link_aliases: None,
                canvas_id: None,
                x: None,
                y: None,
            },
        )
        .unwrap();

        for (index, rating) in [1, 2, 4].iter().enumerate() {
            let current = {
                let database = state.db().unwrap();
                get_card(&database, &card.id).unwrap()
            };
            let mut input = review(&current, &format!("event-{index}"));
            input.rating = *rating;
            input.reviewed_at = format!("2026-01-0{}T00:00:00.000Z", index + 1);
            record_review(&state, input).unwrap();
        }

        let stats = get_card_review_stats(&state, "2026-01-01T00:00:00.000Z").unwrap();
        assert_eq!(stats.len(), 1);
        assert_eq!(stats[0].card_id, card.id);
        assert_eq!(
            (stats[0].reviews, stats[0].again, stats[0].hard, stats[0].good, stats[0].easy),
            (3, 1, 1, 0, 1)
        );
        assert_eq!(stats[0].last_reviewed_at, "2026-01-03T00:00:00.000Z");

        // since 之后没有复习记录就返回空；时间格式错误直接报错。
        assert!(get_card_review_stats(&state, "2026-02-01T00:00:00.000Z").unwrap().is_empty());
        assert!(get_card_review_stats(&state, "not-a-time").is_err());
    }
}
