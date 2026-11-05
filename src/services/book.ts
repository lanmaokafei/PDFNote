import { invoke } from '@tauri-apps/api/core'

/**
 * AI 拆书：两阶段流程。
 * 阶段一按块抽取笔记（存库，可中断续跑），阶段二汇总成层级骨架，最后写入卡片与脑图。
 */
export type DigestMode = 'structure' | 'dictionary' | 'vocabulary' | 'questions'

export interface DigestPage {
  page: number
  text: string
  /** [x, y, width, height]，该页文字区域的归一化包围盒。 */
  bbox: [number, number, number, number] | null
}

export interface DigestItem {
  kind: string
  title: string
  excerpt: string
  page: number | null
  aliases: string
}

export interface ChunkNote {
  chunk_index: number
  page_start: number
  page_end: number
  summary: string
  items: DigestItem[]
  pages: DigestPage[]
}

export interface OutlineNode {
  title: string
  excerpt: string
  page: number | null
  aliases: string
  children: OutlineNode[]
}

export interface BookOutline {
  title: string
  mode: string
  /** 生成骨架时读者选择的层级深度（旧数据没有时按 2 层处理）。 */
  depth: number
  nodes: OutlineNode[]
}

const desktopOnly = () => {
  if (!('__TAURI_INTERNALS__' in window)) {
    throw new Error('此操作需要在 PDFNote 桌面应用中运行')
  }
}

export async function analyzeBookChunk(input: {
  document_id: string
  mode: DigestMode
  chunk_index: number
  pages: DigestPage[]
  /** 深层拆解时阶段一会多抽名词与定义；旧调用缺省按 2 层。 */
  depth?: number
}): Promise<ChunkNote> {
  desktopOnly()
  return invoke('analyze_book_chunk', { input })
}

export async function listBookNotes(documentId: string, mode: DigestMode): Promise<ChunkNote[]> {
  desktopOnly()
  return invoke('list_book_notes', { documentId, mode })
}

/** depth 由读者设置（1–5，默认 2），会同时影响提示词、节点预算与解析上限。 */
export async function synthesizeBook(
  documentId: string,
  mode: DigestMode,
  depth = 2,
): Promise<BookOutline> {
  desktopOnly()
  return invoke('synthesize_book', { documentId, mode, depth })
}

/** 骨架写到读者当前选中的画布；不传时用默认画布 main。 */
export async function applyBookOutline(
  documentId: string,
  mode: DigestMode,
  canvasId?: string,
): Promise<number> {
  desktopOnly()
  return invoke('apply_book_outline', { documentId, mode, canvasId: canvasId ?? null })
}

export async function clearBookAnalysis(documentId: string, mode: DigestMode): Promise<void> {
  desktopOnly()
  return invoke('clear_book_analysis', { documentId, mode })
}
