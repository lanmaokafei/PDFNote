use crate::{
    cards::get_card,
    models::{card_from_row, now, Card, DailyReviewStats, ReviewInput, ReviewStats, CARD_COLUMNS},
    state::AppState,
};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::{params, OptionalExtension};
use uuid::Uuid;

pub fn list_due_cards(
    state: &AppState,
    now: String,
    limit: Option<u32>,
) -> Result<Vec<Card>, String> {
    DateTime::parse_from_rfc3339(&now).map_err(|_| "now must be an RFC 3339 timestamp")?;
    let database = state.db()?;
    let query = format!(
        "SELECT {CARD_COLUMNS} FROM cards
         WHERE surface_review = 1 AND due <= ?1 ORDER BY due, id LIMIT ?2"
    );
    let mut statement = database
        .prepare(&query)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(
            params![now, limit.unwrap_or(200).clamp(1, 500)],
            card_from_row,
        )
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string());
    rows
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
                learning_steps, reps, lapses, new_state, payload_json
             ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20
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
            ],
        )
        .map_err(|error| error.to_string())?;
    let card = get_card(&transaction, &input.card_id)?;
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(card)
}

pub fn get_review_stats(state: &AppState, day_start: String) -> Result<ReviewStats, String> {
    DateTime::parse_from_rfc3339(&day_start)
        .map_err(|_| "dayStart must be an RFC 3339 timestamp")?;
    let database = state.db()?;
    let current_time = now();
    let due_now = database
        .query_row(
            "SELECT COUNT(*) FROM cards WHERE surface_review = 1 AND due <= ?1",
            params![current_time],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let backlog = database
        .query_row(
            "SELECT COUNT(*) FROM cards WHERE surface_review = 1 AND due < ?1",
            params![day_start],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let (completed_today, correct_today): (i64, i64) = database
        .query_row(
            "SELECT COUNT(*), COALESCE(SUM(CASE WHEN rating >= 3 THEN 1 ELSE 0 END), 0)
             FROM review_logs WHERE reviewed_at >= ?1 AND reviewed_at < strftime('%Y-%m-%dT%H:%M:%S', ?1, '+1 day')",
            params![day_start],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|error| error.to_string())?;
    let mut statement = database
        .prepare(
            "SELECT date(reviewed_at), COUNT(*),
             COALESCE(SUM(CASE WHEN rating >= 3 THEN 1 ELSE 0 END), 0)
             FROM review_logs
             WHERE reviewed_at >= strftime('%Y-%m-%dT%H:%M:%S', ?1, '-13 days')
               AND reviewed_at < strftime('%Y-%m-%dT%H:%M:%S', ?1, '+1 day')
             GROUP BY date(reviewed_at) ORDER BY date(reviewed_at)",
        )
        .map_err(|error| error.to_string())?;
    let daily = statement
        .query_map(params![day_start], |row| {
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
}
