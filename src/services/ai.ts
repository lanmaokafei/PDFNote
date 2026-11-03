import { invoke } from '@tauri-apps/api/core'

/**
 * 可选的视觉模型通道。默认未配置 → 应用不发任何网络请求。
 * 支持 OpenAI 兼容接口：本机 Ollama（/v1）、LM Studio，或自填云端 Key。
 */
export interface AiSettings {
  baseUrl: string
  model: string
  apiKey: string
}

export type RecognitionMode = 'formula' | 'table' | 'general'

export interface AiTestResult {
  latencyMs: number
  models: string[]
  /** 配置的模型是否出现在服务列表里（服务无法枚举时为 true）。 */
  modelFound: boolean
  /** 实际探测方式：models 或 chat。 */
  via: 'models' | 'chat'
}

export const EMPTY_AI_SETTINGS: AiSettings = { baseUrl: '', model: '', apiKey: '' }

export const isAiConfigured = (settings: AiSettings) =>
  settings.baseUrl.trim().length > 0 && settings.model.trim().length > 0

const desktopOnly = () => {
  if (!('__TAURI_INTERNALS__' in window)) {
    throw new Error('此操作需要在 PDFNote 桌面应用中运行')
  }
}

export async function getAiSettings(): Promise<AiSettings> {
  desktopOnly()
  return invoke('get_ai_settings')
}

export async function saveAiSettings(settings: AiSettings): Promise<AiSettings> {
  desktopOnly()
  return invoke('save_ai_settings', { settings })
}

export async function testAiConnection(settings: AiSettings): Promise<AiTestResult> {
  desktopOnly()
  return invoke('test_ai_connection', { settings })
}

export async function recognizeSelection(image: string, mode: RecognitionMode): Promise<string> {
  desktopOnly()
  return invoke('recognize_selection', { image, mode })
}
