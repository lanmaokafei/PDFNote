import { invoke } from '@tauri-apps/api/core'

export interface AnkiDeckPreview {
  name: string
  count: number
}

export interface AnkiSample {
  deck: string
  front: string
  back: string
}

export interface AnkiPreview {
  /** anki-standard（6 列）| anki-front-only（只有正面） */
  format: string
  total: number
  has_answers: boolean
  decks: AnkiDeckPreview[]
  samples: AnkiSample[]
}

export interface AnkiImportInput {
  source_path: string
  canvas_id: string
  /** null = 全部牌组；空数组 = 一张都不导入。 */
  deck_names: string[] | null
}

export interface AnkiImportResult {
  imported: number
  groups: number
  skipped: number
  canvas_id: string
}

/** 只解析、不写库：返回牌组列表、卡数与前几条样例。 */
export async function previewAnkiTxt(sourcePath: string): Promise<AnkiPreview> {
  return invoke('preview_anki_txt', { sourcePath })
}

/** 按勾选的牌组把问题卡写进目标画布（单事务、按画布去重）。 */
export async function importAnkiTxt(input: AnkiImportInput): Promise<AnkiImportResult> {
  return invoke('import_anki_txt', { input })
}
