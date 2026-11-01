export interface NormalizedBBox {
  x: number
  y: number
  width: number
  height: number
}

export interface SourceRef {
  document_id: string
  page: number
  bbox: NormalizedBBox
}

export type ReviewState = 'new' | 'learning' | 'review' | 'relearning'

export interface Card {
  id: string
  source_ref: SourceRef | null
  excerpt: string
  user_note: string
  question: string
  parent_id: string | null
  sort_order: number
  collapsed: boolean
  stability: number
  difficulty: number
  due: string
  last_review: string | null
  reps: number
  lapses: number
  review_state: ReviewState
  surface_pdf: boolean
  surface_mindmap: boolean
  surface_review: boolean
  created_at: string
  updated_at: string
}

export interface AnnotationInput {
  kind: 'highlight' | 'underline' | 'text' | 'rectangle'
  geometry: unknown
  style?: Record<string, unknown>
}

export interface CreateCardInput {
  source_ref?: SourceRef
  excerpt?: string
  user_note?: string
  question?: string
  parent_id?: string
  sort_order?: number
  annotation?: AnnotationInput
}

export interface BootstrapStatus {
  database_ready: boolean
  schema_version: number
  document_count: number
  card_count: number
}
