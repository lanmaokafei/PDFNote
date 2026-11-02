import { describe, expect, it } from 'vitest'
import { clampMenuPosition } from './contextMenuPosition'

describe('clampMenuPosition', () => {
  it('places the menu at the pointer when there is room', () => {
    expect(clampMenuPosition(100, 120, 200, 300, 1000, 800))
      .toEqual({ left: 100, top: 120 })
  })

  it('flips to the left of the pointer near the right edge', () => {
    expect(clampMenuPosition(980, 100, 200, 300, 1000, 800))
      .toEqual({ left: 780, top: 100 })
  })

  it('flips above the pointer near the bottom edge', () => {
    expect(clampMenuPosition(100, 780, 200, 300, 1000, 800))
      .toEqual({ left: 100, top: 480 })
  })

  it('clamps when the menu is taller or wider than the viewport', () => {
    expect(clampMenuPosition(500, 500, 1200, 900, 1000, 800))
      .toEqual({ left: 8, top: 8 })
  })

  it('never returns negative coordinates', () => {
    expect(clampMenuPosition(-40, -30, 200, 300, 1000, 800))
      .toEqual({ left: 8, top: 8 })
  })

  it('handles non-finite coordinates', () => {
    expect(clampMenuPosition(Number.NaN, Number.POSITIVE_INFINITY, 200, 300, 1000, 800))
      .toEqual({ left: 8, top: 8 })
  })
})
