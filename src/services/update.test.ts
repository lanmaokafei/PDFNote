import { describe, expect, it } from 'vitest'
import { formatBytes, progressPercent } from './update'

describe('formatBytes', () => {
  it('formats byte counts for the download progress label', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.0 KB')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(11_434_796)).toBe('10.9 MB')
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB')
  })

  it('falls back to a dash for invalid sizes', () => {
    expect(formatBytes(-1)).toBe('—')
    expect(formatBytes(Number.NaN)).toBe('—')
  })
})

describe('progressPercent', () => {
  it('computes clamped integer percentages', () => {
    expect(progressPercent(0, 0)).toBe(0)
    expect(progressPercent(50, 100)).toBe(50)
    expect(progressPercent(1, 3)).toBe(33)
    expect(progressPercent(300, 100)).toBe(100)
    expect(progressPercent(-5, 100)).toBe(0)
    expect(progressPercent(10, Number.NaN)).toBe(0)
  })
})
