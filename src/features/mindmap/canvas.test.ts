import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_CANVAS_ID,
  canvasPreferenceKey,
  documentCanvasName,
  readCanvasId,
  readCanvasPreference,
  saveCanvasId,
} from './canvas'

function stubStorage() {
  const store = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value) },
    removeItem: (key: string) => { store.delete(key) },
  })
  return store
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('canvas preference', () => {
  it('没有 localStorage 时偏好为 null、默认回落到 main', () => {
    expect(readCanvasPreference('doc1')).toBeNull()
    expect(readCanvasId('doc1')).toBe(DEFAULT_CANVAS_ID)
  })

  it('保存后能读回原始偏好', () => {
    stubStorage()
    saveCanvasId('doc1', 'doc-canvas')
    expect(readCanvasPreference('doc1')).toBe('doc-canvas')
    expect(readCanvasId('doc1')).toBe('doc-canvas')
  })

  it('偏好按文档隔离，独立视图用全局 key', () => {
    stubStorage()
    saveCanvasId('doc1', 'canvas-a')
    saveCanvasId('doc2', 'canvas-b')
    saveCanvasId(null, 'canvas-global')
    expect(readCanvasPreference('doc1')).toBe('canvas-a')
    expect(readCanvasPreference('doc2')).toBe('canvas-b')
    expect(readCanvasPreference(null)).toBe('canvas-global')
    expect(canvasPreferenceKey('doc1')).not.toBe(canvasPreferenceKey('doc2'))
  })

  it('空白值视为没有偏好', () => {
    const store = stubStorage()
    store.set(canvasPreferenceKey('doc1'), '   ')
    expect(readCanvasPreference('doc1')).toBeNull()
    expect(readCanvasId('doc1')).toBe(DEFAULT_CANVAS_ID)
  })

  it('文档画布默认名用标题并截断到 60 字', () => {
    expect(documentCanvasName('内科学')).toBe('内科学')
    expect(documentCanvasName('   ')).toBe('本书脑图')
    expect(documentCanvasName(null)).toBe('本书脑图')
    expect(Array.from(documentCanvasName('字'.repeat(120))).length).toBe(60)
  })
})
