import { invoke } from '@tauri-apps/api/core'
import type {
  Annotation,
  AnnotationGeometry,
  BackupResult,
  BootstrapStatus,
  Card,
  CreateCardInput,
  CardLink,
  Document,
  InkStyle,
  CreateMindmapCanvasInput,
  MindmapCanvas,
  MindmapLayout,
  MindmapLayoutInput,
  NormalizedBBox,
  PageInk,
  PageNote,
  CreatePageNoteInput,
  UpdatePageNoteInput,
  ReviewInput,
  ReviewStats,
  UpdateCardContentInput,
} from '../domain/card'

export const isTauriRuntime = () => '__TAURI_INTERNALS__' in window
const desktopOnly = () => {
  if (!isTauriRuntime()) throw new Error('此操作需要在 PDFNote 桌面应用中运行')
}

/** One Vision line with a normalized (0..1, top-left origin) bounding box. */
export interface OcrLine {
  text: string
  x: number
  y: number
  width: number
  height: number
  confidence: number
}

export interface PageOcrRecord {
  documentId: string
  page: number
  linesJson: string
  engine: string
  createdAt: string
}

export async function recognizeNativeImage(imageData: string): Promise<string> {
  desktopOnly()
  return invoke('ocr_image', { imageData })
}

/** Whole-page recognition with per-line geometry (used for the selectable text layer). */
export async function recognizePageLines(imageData: string): Promise<OcrLine[]> {
  desktopOnly()
  return invoke('ocr_page_lines', { imageData })
}

export async function getPageOcr(documentId: string, page: number): Promise<PageOcrRecord | null> {
  if (!isTauriRuntime()) return null
  return invoke('get_page_ocr', { documentId, page })
}

export async function savePageOcr(
  documentId: string,
  page: number,
  linesJson: string,
  engine: string,
): Promise<void> {
  if (!isTauriRuntime()) return
  return invoke('save_page_ocr', { documentId, page, linesJson, engine })
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
export async function readPdfChunk(id: string, begin: number, end: number): Promise<ArrayBuffer> {
  desktopOnly()
  const result = await invoke<ArrayBuffer | number[]>('read_pdf_chunk', { id, begin, end })
  return result instanceof ArrayBuffer ? result : new Uint8Array(result).buffer
}
export async function resolveDocumentPath(id: string): Promise<string> {
  desktopOnly()
  return invoke('resolve_document_path', { id })
}
export async function updateDocumentMetadata(id: string, title: string, pageCount: number): Promise<void> {
  desktopOnly()
  return invoke('update_document_metadata', { id, title, pageCount })
}
export async function setCardTags(cardId: string, tags: string[]): Promise<Card> {
  desktopOnly()
  return invoke('set_card_tags', { cardId, tags })
}
export async function listTags(): Promise<string[]> {
  if (!isTauriRuntime()) return []
  return invoke('list_tags')
}
export async function listCardLinks(): Promise<CardLink[]> {
  if (!isTauriRuntime()) return []
  return invoke('list_card_links')
}
export async function createCardLink(sourceCardId: string, targetCardId: string): Promise<CardLink> {
  desktopOnly()
  return invoke('create_card_link', { sourceCardId, targetCardId })
}
export async function deleteCardLink(id: string): Promise<void> {
  desktopOnly()
  return invoke('delete_card_link', { id })
}
export async function listPageInks(documentId: string, pages: number[]): Promise<PageInk[]> {
  if (!isTauriRuntime()) return []
  return invoke('list_page_inks', { documentId, pages })
}
export async function createPageInk(
  documentId: string,
  page: number,
  bbox: NormalizedBBox,
  style: InkStyle,
): Promise<PageInk> {
  desktopOnly()
  return invoke('create_page_ink', { documentId, page, bbox, style })
}
export async function deletePageInk(id: string): Promise<void> {
  desktopOnly()
  return invoke('delete_page_ink', { id })
}
export async function mergeCards(cardIds: string[]): Promise<Card> {
  desktopOnly()
  return invoke('merge_cards', { cardIds })
}
export async function exportMarkdownFile(path: string, content: string): Promise<void> {
  desktopOnly()
  return invoke('export_markdown', { path, content })
}
export async function updateDocumentProgress(id: string, lastPage: number): Promise<number> {
  if (!isTauriRuntime()) return lastPage
  return invoke('update_document_progress', { id, lastPage })
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

/** 默认取满 10000 张：Anki 牌组导入后单库可能有数千张卡片，不能漏掉后面的画布。 */
export async function listCards(limit = 10000): Promise<Card[]> {
  if (!isTauriRuntime()) return []
  return invoke('list_cards', { limit })
}
export async function listDueCards(now: string, limit = 200): Promise<Card[]> {
  if (!isTauriRuntime()) return []
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
export async function removeCardFromMindmap(id: string, canvasId?: string): Promise<void> {
  desktopOnly()
  return invoke('remove_card_from_mindmap', { id, canvasId: canvasId ?? null })
}
export async function deleteCard(id: string): Promise<void> {
  desktopOnly()
  return invoke('delete_card', { id })
}

/** 批量清空指定画布；返回受影响数量。remove 只移除该画布布局，delete 级联删除卡片。 */
export async function clearMindmapCards(mode: 'remove' | 'delete', canvasId?: string): Promise<number> {
  desktopOnly()
  return invoke('clear_mindmap_cards', { mode, canvasId: canvasId ?? null })
}

export async function listMindmapCanvases(documentId?: string | null): Promise<MindmapCanvas[]> {
  if (!isTauriRuntime()) {
    return [{
      id: 'main', document_id: null, name: '默认画布', card_count: 0,
      created_at: '', updated_at: '',
    }]
  }
  return invoke('list_mindmap_canvases', { documentId: documentId ?? null })
}
export async function createMindmapCanvas(input: CreateMindmapCanvasInput): Promise<MindmapCanvas> {
  desktopOnly()
  return invoke('create_mindmap_canvas', { input })
}
export async function renameMindmapCanvas(id: string, name: string): Promise<MindmapCanvas> {
  desktopOnly()
  return invoke('rename_mindmap_canvas', { id, name })
}
export async function deleteMindmapCanvas(id: string): Promise<number> {
  desktopOnly()
  return invoke('delete_mindmap_canvas', { id })
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

/** 把渲染崩溃的错误与组件栈写入本地日志文件，便于离线诊断。 */
export async function appendCrashLog(payload: string): Promise<void> {
  if (!isTauriRuntime()) return
  await invoke('append_crash_log', { payload }).catch(() => undefined)
}

export async function listPageNotes(documentId: string): Promise<PageNote[]> {
  return invoke('list_page_notes', { documentId })
}

export async function createPageNote(input: CreatePageNoteInput): Promise<PageNote> {
  return invoke('create_page_note', { input })
}

export async function updatePageNote(input: UpdatePageNoteInput): Promise<PageNote> {
  return invoke('update_page_note', { input })
}

export async function deletePageNote(id: string): Promise<void> {
  return invoke('delete_page_note', { id })
}
