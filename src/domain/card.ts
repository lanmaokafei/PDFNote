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
export type ReviewSource = 'flashcard' | 'document_recall' | 'mindmap_recall'
export type Rating = 1 | 2 | 3 | 4

export interface Card {
  id: string
  source_ref: SourceRef | null
  excerpt: string
  user_note: string
  question: string
  /** 标签按字母序返回。 */
  tags: string[]
  parent_id: string | null
  sort_order: number
  collapsed: boolean
  stability: number
  difficulty: number
  elapsed_days: number
  scheduled_days: number
  learning_steps: number
  due: string
  last_review: string | null
  reps: number
  lapses: number
  review_state: ReviewState
  surface_pdf: boolean
  surface_mindmap: boolean
  surface_review: boolean
  /** 选区截图（data URL）。扫描版 PDF 的公式或图像摘录随卡片存档。 */
  excerpt_image: string | null
  /** 标题链接别名，分号分隔；为空时只用 question 作为关键词。 */
  link_aliases: string
  created_at: string
  updated_at: string
}

export type AnnotationKind = 'highlight' | 'underline' | 'text' | 'rectangle'
export interface AnnotationGeometry {
  rects: NormalizedBBox[]
}
export interface AnnotationInput {
  kind: AnnotationKind
  geometry: AnnotationGeometry
  style?: Record<string, unknown>
}
export interface Annotation extends AnnotationInput {
  id: string
  card_id: string
  page: number
  created_at: string
  updated_at: string
}

export interface CreateCardInput {
  source_ref?: SourceRef
  excerpt?: string
  user_note?: string
  question?: string
  parent_id?: string
  sort_order?: number
  annotation?: AnnotationInput
  /** 选区截图（data URL），用于无法文字识别的公式或图像摘录。 */
  excerpt_image?: string
  /** 标题链接别名（分号分隔），创建时可选。 */
  link_aliases?: string
}

export interface UpdateCardContentInput {
  id: string
  excerpt: string
  user_note: string
  question: string
  /** 标题链接别名（分号分隔）；不传时保留原值。 */
  link_aliases?: string
}

export interface CardLink {
  id: string
  source_card_id: string
  target_card_id: string
  label: string
  created_at: string
}

export interface InkStyle {
  color?: string
  width?: number
  points: Array<[number, number]>
}

export interface PageInk {
  id: string
  document_id: string
  page: number
  bbox: NormalizedBBox
  style: InkStyle
  created_at: string
  updated_at: string
}

export interface Document {
  id: string
  title: string
  stored_path: string
  original_path: string | null
  content_hash: string
  file_size: number
  page_count: number
  file_status: 'importing' | 'ready' | 'missing' | 'mismatch'
  /** 上次阅读到的页码，重新打开时用于恢复位置。 */
  last_page: number
  created_at: string
  updated_at: string
}

export interface MindmapLayout {
  card_id: string
  canvas_id: string
  x: number
  y: number
  updated_at: string
}

export interface MindmapLayoutInput {
  card_id: string
  canvas_id?: string
  x: number
  y: number
}

export interface ReviewInput {
  card_id: string
  client_event_id: string
  session_id: string
  rating: Rating
  source: ReviewSource
  scheduler_version: string
  expected_updated_at: string
  reviewed_at: string
  stability: number
  difficulty: number
  elapsed_days: number
  scheduled_days: number
  learning_steps: number
  due: string
  reps: number
  lapses: number
  review_state: ReviewState
}

export interface ReviewStats {
  due_now: number
  completed_today: number
  correct_today: number
  backlog: number
  daily: Array<{ day: string; reviews: number; correct: number }>
}

export interface BootstrapStatus {
  database_ready: boolean
  schema_version: number
  document_count: number
  card_count: number
}

export interface BackupResult {
  path: string
  documents: number
  cards: number
}
