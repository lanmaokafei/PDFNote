import { invoke } from '@tauri-apps/api/core'
import type {
  Annotation,
  AnnotationGeometry,
  BackupResult,
  BootstrapStatus,
  Card,
  CreateCardInput,
  Document,
  MindmapLayout,
  MindmapLayoutInput,
  NormalizedBBox,
  ReviewInput,
  ReviewStats,
  UpdateCardContentInput,
} from '../domain/card'

export const isTauriRuntime = () => '__TAURI_INTERNALS__' in window
const desktopOnly = () => {
  if (!isTauriRuntime()) throw new Error('此操作需要在 PDFNote 桌面应用中运行')
}

export async function getBootstrapStatus(): Promise<BootstrapStatus> {
  if (!isTauriRuntime()) return { database_ready: false, schema_version: 1, document_count: 0, card_count: 0 }
  return invoke('get_bootstrap_status')
}

export async function listDocuments(): Promise<Document[]> {
  if (!isTauriRuntime()) return []
  return invoke('list_documents')
}
export async function importDocument(sourcePath: string): Promise<Document> {
  desktopOnly()
  return invoke('import_document', { sourcePath })
}
export async function resolveDocumentPath(id: string): Promise<string> {
  desktopOnly()
  return invoke('resolve_document_path', { id })
}
export async function updateDocumentMetadata(id: string, title: string, pageCount: number): Promise<void> {
  desktopOnly()
  return invoke('update_document_metadata', { id, title, pageCount })
}
export async function verifyDocument(id: string): Promise<Document> {
  desktopOnly()
  return invoke('verify_document', { id })
}
export async function relocateDocument(id: string, sourcePath: string): Promise<Document> {
  desktopOnly()
  return invoke('relocate_document', { id, sourcePath })
}
export async function deleteDocument(id: string, keepCards: boolean): Promise<void> {
  desktopOnly()
  return invoke('delete_document', { id, keepCards })
}

export async function listCards(limit = 500): Promise<Card[]> {
  if (!isTauriRuntime()) return []
  return invoke('list_cards', { limit })
}
export async function listDueCards(now: string, limit = 200): Promise<Card[]> {
  desktopOnly()
  return invoke('list_due_cards', { now, limit })
}
export async function createCard(input: CreateCardInput): Promise<Card> {
  desktopOnly()
  return invoke('create_card', { input })
}
export async function updateCardContent(input: UpdateCardContentInput): Promise<Card> {
  desktopOnly()
  return invoke('update_card_content', { input })
}
export async function removeCardFromMindmap(id: string): Promise<void> {
  desktopOnly()
  return invoke('remove_card_from_mindmap', { id })
}
export async function deleteCard(id: string): Promise<void> {
  desktopOnly()
  return invoke('delete_card', { id })
}

export async function listAnnotations(documentId: string, pages: number[]): Promise<Annotation[]> {
  if (!isTauriRuntime()) return []
  return invoke('list_annotations', { documentId, pages })
}
export async function updateAnnotationGeometry(id: string, geometry: AnnotationGeometry, bbox: NormalizedBBox): Promise<void> {
  desktopOnly()
  return invoke('update_annotation_geometry', { id, geometry, bbox })
}
export async function removeAnnotation(id: string, deleteCard: boolean): Promise<void> {
  desktopOnly()
  return invoke('remove_annotation', { id, deleteCard })
}

export async function listMindmapLayout(canvasId = 'main'): Promise<MindmapLayout[]> {
  if (!isTauriRuntime()) return []
  return invoke('list_mindmap_layout', { canvasId })
}
export async function saveMindmapLayout(layouts: MindmapLayoutInput[]): Promise<void> {
  desktopOnly()
  return invoke('save_mindmap_layout', { layouts })
}
export async function moveCard(id: string, parentId: string | null, sortOrder: number): Promise<Card> {
  desktopOnly()
  return invoke('move_card', { id, parentId, sortOrder })
}
export async function setCardCollapsed(id: string, collapsed: boolean): Promise<Card> {
  desktopOnly()
  return invoke('set_card_collapsed', { id, collapsed })
}

export async function recordReview(input: ReviewInput): Promise<Card> {
  desktopOnly()
  return invoke('record_review', { input })
}
export async function getReviewStats(dayStart: string): Promise<ReviewStats> {
  if (!isTauriRuntime()) return { due_now: 0, completed_today: 0, correct_today: 0, backlog: 0, daily: [] }
  return invoke('get_review_stats', { dayStart })
}

export async function exportBackup(destinationPath: string): Promise<BackupResult> {
  desktopOnly()
  return invoke('export_backup', { destinationPath })
}
export async function importBackup(sourcePath: string, mode: 'merge' | 'overwrite'): Promise<BackupResult> {
  desktopOnly()
  return invoke('import_backup', { sourcePath, mode })
}
export async function autoBackup(): Promise<string> {
  desktopOnly()
  return invoke('auto_backup')
}
