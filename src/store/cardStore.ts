import { create } from 'zustand'
import type { Card, CreateCardInput } from '../domain/card'
import * as api from '../services/pdfnote'

interface CardState {
  cardsById: Record<string, Card>
  loadCards: () => Promise<void>
  createCard: (input: CreateCardInput) => Promise<Card>
  removeFromMindmap: (id: string) => Promise<void>
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

  removeFromMindmap: async (id) => {
    await api.removeCardFromMindmap(id)
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
  },
}))
