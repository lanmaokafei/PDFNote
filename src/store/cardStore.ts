import { create } from 'zustand'
import type { Card, CreateCardInput } from '../domain/card'
import * as api from '../services/pdfnote'

interface CardState {
  cardsById: Record<string, Card>
  loadCards: () => Promise<void>
  createCard: (input: CreateCardInput) => Promise<Card>
  removeFromMindmap: (id: string, canvasId?: string) => Promise<void>
  deleteCard: (id: string) => Promise<void>
}

export const useCardStore = create<CardState>((set) => ({
  cardsById: {},

  loadCards: async () => {
    const cards = await api.listCards()
    set({
      cardsById: Object.fromEntries(cards.map((card) => [card.id, card])),
    })
  },

  createCard: async (input) => {
    const card = await api.createCard(input)
    set((state) => ({
      cardsById: { ...state.cardsById, [card.id]: card },
    }))
    return card
  },

  removeFromMindmap: async (id, canvasId) => {
    await api.removeCardFromMindmap(id, canvasId)
    set((state) => {
      const card = state.cardsById[id]
      if (!card) return state
      return {
        cardsById: {
          ...state.cardsById,
          [id]: { ...card, surface_mindmap: false, parent_id: null },
        },
      }
    })
  },

  deleteCard: async (id) => {
    await api.deleteCard(id)
    set((state) => {
      const next = { ...state.cardsById }
      delete next[id]
      return { cardsById: next }
    })
    // PDF 工作区的标注缓存不依赖卡片列表，必须显式通知它清理，
    // 否则页面上会残留“幽灵标注”，点击删除时后端返回 annotation not found。
    window.dispatchEvent(new CustomEvent('pdfnote:card-deleted', { detail: { cardId: id } }))
  },
}))
