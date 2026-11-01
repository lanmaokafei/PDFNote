import { fsrs, State, type Card as FsrsCard } from 'ts-fsrs'
import type { Card, Rating, ReviewSource } from '../../domain/card'
import { recordReview } from '../../services/pdfnote'

export const SCHEDULER_VERSION = 'ts-fsrs-5.4.2'
const scheduler = fsrs()
const states = [State.New, State.Learning, State.Review, State.Relearning] as const
const stateNames = ['new', 'learning', 'review', 'relearning'] as const

export function toFsrsCard(card: Card): FsrsCard {
  return {
    due: new Date(card.due),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsed_days: card.elapsed_days,
    scheduled_days: card.scheduled_days,
    learning_steps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: states[card.review_state === 'new' ? 0 : card.review_state === 'learning' ? 1 : card.review_state === 'review' ? 2 : 3],
    last_review: card.last_review ? new Date(card.last_review) : undefined,
  }
}

export async function reviewCard(
  card: Card,
  rating: Rating,
  source: ReviewSource,
  sessionId: string,
): Promise<Card> {
  const requestedTime = new Date()
  const previousReview = card.last_review ? new Date(card.last_review) : null
  const reviewTime = previousReview && requestedTime < previousReview ? previousReview : requestedTime
  const result = scheduler.next(toFsrsCard(card), reviewTime, rating)
  const next = result.card

  return recordReview({
    card_id: card.id,
    client_event_id: crypto.randomUUID(),
    session_id: sessionId,
    rating,
    source,
    scheduler_version: SCHEDULER_VERSION,
    expected_updated_at: card.updated_at,
    reviewed_at: reviewTime.toISOString(),
    stability: next.stability,
    difficulty: next.difficulty,
    elapsed_days: next.elapsed_days,
    scheduled_days: next.scheduled_days,
    learning_steps: next.learning_steps,
    due: next.due.toISOString(),
    reps: next.reps,
    lapses: next.lapses,
    review_state: stateNames[next.state],
  })
}
