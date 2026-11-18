import { State, type Card as FsrsCard } from 'ts-fsrs'
import type { Card, Rating, ReviewSource } from '../../domain/card'
import { recordReview, revertReview } from '../../services/pdfnote'
import { pushUndo } from '../undo/undoStack'
import { currentScheduler, schedulerVersion } from './fsrsSettings'

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

const RATING_LABELS: Record<number, string> = { 1: '重来', 2: '困难', 3: '良好', 4: '容易' }

/** 撤销/重做评分后广播，让各视图把卡片放回队列或标记为已评分。 */
export const REVIEW_SCHEDULE_EVENT = 'pdfnote:review-schedule-changed'

export interface ReviewScheduleChange {
  card: Card
  action: 'undo' | 'redo'
}

/** 真正写库的那一步，撤销与重做都复用它。 */
async function applyReview(
  card: Card,
  rating: Rating,
  source: ReviewSource,
  sessionId: string,
): Promise<{ card: Card; clientEventId: string }> {
  const requestedTime = new Date()
  const previousReview = card.last_review ? new Date(card.last_review) : null
  const reviewTime = previousReview && requestedTime < previousReview ? previousReview : requestedTime
  // 每次按当前设置取调度器：改保留率/步骤后下一张卡就生效。
  const result = currentScheduler().next(toFsrsCard(card), reviewTime, rating)
  const next = result.card
  const clientEventId = crypto.randomUUID()
  const updated = await recordReview({
    card_id: card.id,
    client_event_id: clientEventId,
    session_id: sessionId,
    rating,
    source,
    scheduler_version: schedulerVersion(),
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
  return { card: updated, clientEventId }
}

function broadcast(change: ReviewScheduleChange): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<ReviewScheduleChange>(REVIEW_SCHEDULE_EVENT, { detail: change }))
}

/**
 * 评分 + 一条撤销记录。
 *
 * 撤销 = 后端恢复评分前状态（含删除日志与回退统计）；重做 = 用同一档评分再评一次。
 * 三个评分入口（闪卡 / 文档回忆 / 脑图回忆）共用这里，所以 ⌘Z 在哪都能退回上一档。
 */
export async function reviewCard(
  card: Card,
  rating: Rating,
  source: ReviewSource,
  sessionId: string,
): Promise<Card> {
  const outcome = await applyReview(card, rating, source, sessionId)
  let eventId = outcome.clientEventId
  let base = card
  pushUndo({
    label: `复习评分（${RATING_LABELS[rating] ?? rating}）`,
    undo: async () => {
      base = await revertReview(eventId)
      broadcast({ card: base, action: 'undo' })
    },
    redo: async () => {
      const again = await applyReview(base, rating, source, sessionId)
      eventId = again.clientEventId
      broadcast({ card: again.card, action: 'redo' })
    },
  })
  return outcome.card
}
