import { describe, expect, it } from 'vitest'
import { State } from 'ts-fsrs'
import type { Card } from '../../domain/card'
import { toFsrsCard } from './scheduler'

function card(overrides: Partial<Card> = {}): Card {
  return {
    id: 'card-1',
    source_ref: null,
    excerpt: '摘录',
    user_note: '笔记',
    question: '问题',
  tags: [],
    excerpt_image: null,
    link_aliases: '',
    parent_id: null,
    sort_order: 0,
    collapsed: false,
    stability: 0,
    difficulty: 0,
    elapsed_days: 0,
    scheduled_days: 0,
    learning_steps: 0,
    due: '2026-01-01T00:00:00.000Z',
    last_review: null,
    reps: 0,
    lapses: 0,
    review_state: 'new',
    surface_pdf: true,
    surface_mindmap: true,
    surface_review: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('FSRS card mapping', () => {
  it('maps every review state to the ts-fsrs state', () => {
    expect(toFsrsCard(card()).state).toBe(State.New)
    expect(toFsrsCard(card({ review_state: 'learning' })).state).toBe(State.Learning)
    expect(toFsrsCard(card({ review_state: 'review' })).state).toBe(State.Review)
    expect(toFsrsCard(card({ review_state: 'relearning' })).state).toBe(State.Relearning)
  })

  it('preserves scheduling fields without mutating the source card', () => {
    const source = card({
      stability: 9.2,
      difficulty: 4.7,
      elapsed_days: 12,
      scheduled_days: 30,
      reps: 6,
      lapses: 1,
      due: '2026-06-01T00:00:00.000Z',
      last_review: '2026-05-01T00:00:00.000Z',
      review_state: 'review',
    })
    const mapped = toFsrsCard(source)
    expect(mapped.due.toISOString()).toBe('2026-06-01T00:00:00.000Z')
    expect(mapped.last_review?.toISOString()).toBe('2026-05-01T00:00:00.000Z')
    expect(mapped.stability).toBe(9.2)
    expect(mapped.scheduled_days).toBe(30)
    expect(source.stability).toBe(9.2)
  })
})
