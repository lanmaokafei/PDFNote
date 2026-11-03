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
}): Promise<ChunkNote> {
  desktopOnly()
  return invoke('analyze_book_chunk', { input })
}

export async function listBookNotes(documentId: string, mode: DigestMode): Promise<ChunkNote[]> {
  desktopOnly()
  return invoke('list_book_notes', { documentId, mode })
}

export async function synthesizeBook(documentId: string, mode: DigestMode): Promise<BookOutline> {
  desktopOnly()
  return invoke('synthesize_book', { documentId, mode })
}

export async function applyBookOutline(documentId: string, mode: DigestMode): Promise<number> {
  desktopOnly()
  return invoke('apply_book_outline', { documentId, mode })
}

export async function clearBookAnalysis(documentId: string, mode: DigestMode): Promise<void> {
  desktopOnly()
  return invoke('clear_book_analysis', { documentId, mode })
}
