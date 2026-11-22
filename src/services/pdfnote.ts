import { invoke } from '@tauri-apps/api/core'
import type {
  Annotation,
  AnnotationGeometry,
  BackupResult,
  BootstrapStatus,
  Card,
  CreateCardInput,
  CardLink,
  CardOrderUpdate,
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
  Notebook,
  NotebookInk,
  CreateNotebookInkInput,
  Layer,
  PaperStyle,
  LayerScope,
  CanvasInk,
  CreateCanvasInkInput,
  LayerMember,
  ReviewInput,
  ReviewStats,
  UpdateCardContentInput,
} from '../domain/card'

export const isTauriRuntime = () => '__TAURI_INTERNALS__' in window
const desktopOnly = () => {
  if (!isTauriRuntime()) throw new Error('此操作需要在 PDFNote 桌面应用中运行')
}

/** One Vision line with a normalized (0..1, top-left origin) bounding box. */
/**
 * PDF 文字层里的一个文本 run（PDF.js 的 text item）。
 * 有真实文字层的页面按 run 定位，字号、基线、字宽都直接来自 PDF，
 * 不依赖「行高 × 系数」估算，因此任何字号都能对得上。
 */
export interface OcrRun {
  text: string
  /** 归一化页面坐标（左上原点）。 */
  x: number
  width: number
  /** 基线到页顶的距离（归一化）。 */
  baselineTop: number
  /** 字号（归一化到页高）。 */
  fontSize: number
}

export interface OcrLine {
  text: string
  x: number
  y: number
  width: number
  height: number
  confidence: number
  /** PDF 文字层才有的精确 run；OCR 行没有，退回按行估算。 */
  runs?: OcrRun[]
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
/** 标签 + 使用次数：标签管理面板用。 */
export interface TagStat {
  tag: string
  count: number
}

export async function listTagStats(): Promise<TagStat[]> {
  if (!isTauriRuntime()) return []
  return invoke('list_tag_stats')
}

/** 重命名标签；目标已存在时自动合并。返回受影响的卡片数。 */
export async function renameTag(from: string, to: string): Promise<number> {
  desktopOnly()
  return invoke('rename_tag', { from, to })
}

export async function deleteTag(tag: string): Promise<number> {
  desktopOnly()
  return invoke('delete_tag', { tag })
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
/** 导出当前画布的卡片为 AnkiDroid 可导入的 txt（标准 4 列）。 */
export async function exportAnkiTxt(path: string, canvasId: string | null): Promise<number> {
  desktopOnly()
  return invoke('export_anki_txt', { input: { path, canvasId } })
}

export async function exportOpmlFile(path: string, content: string): Promise<void> {
  desktopOnly()
  return invoke('export_opml', { path, content })
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

/** 只改书名，不动页数、进度与文件状态。 */
export async function renameDocument(id: string, title: string): Promise<Document> {
  desktopOnly()
  return invoke('rename_document', { id, title })
}

/** 回收站里的一本书：文档本体 + 删除时间（PDF 副本仍保留）。 */
export interface TrashedDocument {
  document: Document
  deletedAt: string
}

/** 移入回收站：文档与它的卡片一起从列表消失，30 天内可恢复。 */
export async function trashDocument(id: string): Promise<void> {
  desktopOnly()
  return invoke('trash_document', { id })
}

export async function listTrashedDocuments(limit = 200): Promise<TrashedDocument[]> {
  if (!isTauriRuntime()) return []
  return invoke('list_trashed_documents', { limit })
}

export async function restoreDocument(id: string): Promise<Document> {
  desktopOnly()
  return invoke('restore_document', { id })
}

/** 彻底删除回收站里的文档：卡片、标注、复习记录与 PDF 副本一起删掉。 */
export async function purgeDocument(id: string): Promise<void> {
  desktopOnly()
  return invoke('purge_document', { id })
}

/** 前端渲染好的图片：单张直接写盘，多张打成 zip。 */
export interface ExportImageFile {
  name: string
  /** 不含 data: 前缀的 base64。 */
  base64: string
}

export async function saveExportFiles(destination: string, files: ExportImageFile[]): Promise<string> {
  desktopOnly()
  return invoke('save_export_files', { destination, files })
}

export async function purgeExpiredDocumentTrash(days = 30): Promise<number> {
  if (!isTauriRuntime()) return 0
  return invoke('purge_expired_document_trash', { days })
}

/** 默认取满 10000 张：Anki 牌组导入后单库可能有数千张卡片，不能漏掉后面的画布。 */
export async function listCards(limit = 10000): Promise<Card[]> {
  if (!isTauriRuntime()) return []
  return invoke('list_cards', { limit })
}
export async function listDueCards(now: string, limit = 200, cardIds?: string[]): Promise<Card[]> {
  if (!isTauriRuntime()) return []
  // cardIds 有值 = 只复习这一组卡（学习报告里的「卡住清单」）；空数组表示没有卡。
  return invoke('list_due_cards', { now, limit, cardIds: cardIds ?? null })
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

/** 回收站里的一张卡：卡片本体 + 删除时间（删除只是登记，卡片行还在）。 */
export interface TrashedCard {
  card: Card
  deletedAt: string
}

export async function listTrashedCards(limit = 200): Promise<TrashedCard[]> {
  if (!isTauriRuntime()) return []
  return invoke('list_trashed_cards', { limit })
}

export async function restoreCard(id: string): Promise<Card> {
  desktopOnly()
  return invoke('restore_card', { id })
}

export async function purgeTrashedCard(id: string): Promise<void> {
  desktopOnly()
  return invoke('purge_trashed_card', { id })
}

/** 清理过期回收站（默认 30 天），返回删除数量。 */
export async function purgeExpiredTrash(days = 30): Promise<number> {
  if (!isTauriRuntime()) return 0
  return invoke('purge_expired_trash', { days })
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
/** 大纲编辑：一次事务提交整层「父节点 + 顺序」，后端逐条防环、失败整批回滚。 */
export async function applyCardOrder(updates: CardOrderUpdate[]): Promise<void> {
  if (!updates.length) return
  desktopOnly()
  return invoke('apply_card_order', { updates })
}
export async function setCardCollapsed(id: string, collapsed: boolean): Promise<Card> {
  desktopOnly()
  return invoke('set_card_collapsed', { id, collapsed })
}

export async function recordReview(input: ReviewInput): Promise<Card> {
  desktopOnly()
  return invoke('record_review', { input })
}
/** 学习报告：按卡片聚合一段时间的复习次数与四档评分分布。 */
export interface CardReviewStat {
  cardId: string
  reviews: number
  again: number
  hard: number
  good: number
  easy: number
  lastReviewedAt: string
}

export async function getCardReviewStats(since: string): Promise<CardReviewStat[]> {
  if (!isTauriRuntime()) return []
  return invoke('get_card_review_stats', { since })
}

/** 跨书学习汇总：一段时间内写卡、复习，以及按书拆开的明细。 */
export interface StudyBookStat {
  documentId: string | null
  title: string
  cardsWritten: number
  reviews: number
  reviewedCards: number
}

export interface StudyOverview {
  cardsWritten: number
  reviews: number
  reviewedCards: number
  correct: number
  books: StudyBookStat[]
}

/** 撤销一次评分：后端恢复评分前的调度状态并删除那条日志。 */
export async function revertReview(clientEventId: string): Promise<Card> {
  desktopOnly()
  return invoke('revert_review', { clientEventId })
}

export async function getStudyOverview(since: string): Promise<StudyOverview> {
  if (!isTauriRuntime()) {
    return { cardsWritten: 0, reviews: 0, reviewedCards: 0, correct: 0, books: [] }
  }
  return invoke('get_study_overview', { since })
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

/** 两遍阅读：一本书一行，没有行时按第一遍处理。 */
export interface ReadingState {
  documentId: string
  pass: number
  recallNote: string
  /** 目录骨架映射 JSON（按画布分组），由「按目录建骨架」写入。 */
  tocJson: string
  updatedAt: string
}

export async function getReadingState(documentId: string): Promise<ReadingState> {
  if (!isTauriRuntime()) return { documentId, pass: 1, recallNote: '', tocJson: '', updatedAt: '' }
  return invoke('get_reading_state', { input: { documentId } })
}

export async function setReadingPass(documentId: string, pass: number): Promise<ReadingState> {
  desktopOnly()
  return invoke('set_reading_pass', { input: { documentId, pass } })
}

/** 阅读计时与年度排行（按「书 + 本地日期」累计）。 */
export interface ReadingBookStat {
  documentId: string
  title: string
  yearSeconds: number
  todaySeconds: number
}

export interface ReadingStats {
  todaySeconds: number
  yearSeconds: number
  books: ReadingBookStat[]
}

export async function addReadingTime(documentId: string, day: string, seconds: number): Promise<void> {
  if (!isTauriRuntime()) return
  return invoke('add_reading_time', { input: { documentId, day, seconds } })
}

/** 跨书阅读日历：区间内每天的合计秒数（年度回顾用）。 */
export interface ReadingDay {
  day: string
  seconds: number
}

export async function getReadingDays(startDay: string, endDay: string): Promise<ReadingDay[]> {
  if (!isTauriRuntime()) return []
  return invoke('get_reading_days', { startDay, endDay })
}

export async function getReadingStats(day: string, yearStart: string): Promise<ReadingStats> {
  if (!isTauriRuntime()) return { todaySeconds: 0, yearSeconds: 0, books: [] }
  return invoke('get_reading_stats', { input: { day, yearStart } })
}

export async function saveRecallNote(documentId: string, note: string): Promise<ReadingState> {
  desktopOnly()
  return invoke('save_recall_note', { input: { documentId, note } })
}

export async function saveTocJson(documentId: string, tocJson: string): Promise<ReadingState> {
  desktopOnly()
  return invoke('save_toc_json', { input: { documentId, tocJson } })
}

export async function listNotebooks(): Promise<Notebook[]> {
  if (!isTauriRuntime()) return []
  return invoke('list_notebooks')
}

export async function createNotebook(title: string, paper: PaperStyle): Promise<Notebook> {
  desktopOnly()
  return invoke('create_notebook', { input: { title, paper } })
}

export async function updateNotebook(id: string, title: string, paper: PaperStyle): Promise<Notebook> {
  desktopOnly()
  return invoke('update_notebook', { input: { id, title, paper } })
}

export async function deleteNotebook(id: string): Promise<void> {
  desktopOnly()
  return invoke('delete_notebook', { id })
}

export async function listLayers(scope: LayerScope, ownerId: string): Promise<Layer[]> {
  if (!isTauriRuntime()) return []
  return invoke('list_layers', { scope, ownerId })
}

export async function createLayer(scope: LayerScope, ownerId: string, name = ''): Promise<Layer> {
  desktopOnly()
  return invoke('create_layer', { input: { scope, owner_id: ownerId, name } })
}

export async function updateLayer(
  id: string,
  changes: { name?: string; visible?: boolean; locked?: boolean },
): Promise<Layer> {
  desktopOnly()
  return invoke('update_layer', { input: { id, ...changes } })
}

export async function deleteLayer(id: string): Promise<void> {
  desktopOnly()
  return invoke('delete_layer', { id })
}

export async function listNotebookInks(notebookId: string): Promise<NotebookInk[]> {
  if (!isTauriRuntime()) return []
  return invoke('list_notebook_inks', { notebookId })
}

export async function createNotebookInk(input: CreateNotebookInkInput): Promise<NotebookInk> {
  desktopOnly()
  return invoke('create_notebook_ink', { input })
}

export async function listCanvasInks(canvasId: string): Promise<CanvasInk[]> {
  if (!isTauriRuntime()) return []
  return invoke('list_canvas_inks', { canvasId })
}

export async function createCanvasInk(input: CreateCanvasInkInput): Promise<CanvasInk> {
  desktopOnly()
  return invoke('create_canvas_ink', { input })
}

export async function deleteCanvasInk(id: string): Promise<void> {
  desktopOnly()
  return invoke('delete_canvas_ink', { id })
}

export async function listLayerMembers(canvasId: string): Promise<LayerMember[]> {
  if (!isTauriRuntime()) return []
  return invoke('list_layer_members', { canvasId })
}

export async function setCardLayer(
  canvasId: string,
  cardId: string,
  layerId: string | null,
): Promise<void> {
  desktopOnly()
  return invoke('set_card_layer', { input: { canvas_id: canvasId, card_id: cardId, layer_id: layerId } })
}

export async function deleteNotebookInk(id: string): Promise<void> {
  desktopOnly()
  return invoke('delete_notebook_ink', { id })
}


/** 跨库搜索命中：文档标题 / 卡片内容 / 笔记本标题。 */
export interface GlobalHit {
  kind: 'document' | 'card' | 'notebook'
  id: string
  title: string
  snippet: string
  documentId: string | null
  page: number | null
}

export async function globalSearch(query: string, limit = 12): Promise<GlobalHit[]> {
  if (!isTauriRuntime()) return []
  return invoke('global_search', { query, limit })
}
