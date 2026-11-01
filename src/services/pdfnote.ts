import { invoke } from '@tauri-apps/api/core'
import type {
  BootstrapStatus,
  Card,
  CreateCardInput,
} from '../domain/card'

const isTauri = () => '__TAURI_INTERNALS__' in window

export async function getBootstrapStatus(): Promise<BootstrapStatus> {
  if (!isTauri()) {
    return {
      database_ready: false,
      schema_version: 1,
      document_count: 0,
      card_count: 0,
    }
  }
  return invoke<BootstrapStatus>('get_bootstrap_status')
}

export async function createCard(input: CreateCardInput): Promise<Card> {
  if (!isTauri()) throw new Error('创建卡片需要在 Tauri 桌面环境中运行')
  return invoke<Card>('create_card', { input })
}

export async function listCards(limit = 200): Promise<Card[]> {
  if (!isTauri()) return []
  return invoke<Card[]>('list_cards', { limit })
}

export async function removeCardFromMindmap(id: string): Promise<void> {
  if (!isTauri()) return
  return invoke<void>('remove_card_from_mindmap', { id })
}

export async function deleteCard(id: string): Promise<void> {
  if (!isTauri()) return
  return invoke<void>('delete_card', { id })
}
