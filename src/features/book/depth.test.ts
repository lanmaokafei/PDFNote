import { describe, expect, it, vi } from 'vitest'
import type { OutlineNode } from '../../services/book'
import {
  countOutlineNodes,
  DEFAULT_DEPTH,
  DEPTH_OPTIONS,
  DEPTH_STORAGE_KEY,
  MAX_DEPTH,
  normalizeDepth,
  outlineDepth,
  readDepth,
  saveDepth,
} from './depth'

const storage = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
})

const node = (title: string, children: OutlineNode[] = []): OutlineNode => ({
  title,
  excerpt: '',
  page: null,
  aliases: '',
  children,
})

describe('拆分层级设置', () => {
  it('默认值与越界收敛', () => {
    expect(DEFAULT_DEPTH).toBe(2)
    expect(normalizeDepth(undefined)).toBe(2)
    expect(normalizeDepth('4')).toBe(4)
    expect(normalizeDepth(0)).toBe(1)
    expect(normalizeDepth(99)).toBe(MAX_DEPTH)
    expect(normalizeDepth(2.6)).toBe(3)
    expect(normalizeDepth(Number.NaN)).toBe(2)
    expect(DEPTH_OPTIONS.map((option) => option.value)).toEqual([1, 2, 3, 4, 5])
  })

  it('记住读者设置，重新打开向导仍生效', () => {
    storage.clear()
    expect(readDepth()).toBe(2)
    expect(saveDepth(4)).toBe(4)
    expect(storage.get(DEPTH_STORAGE_KEY)).toBe('4')
    expect(readDepth()).toBe(4)
    storage.set(DEPTH_STORAGE_KEY, '12')
    expect(readDepth()).toBe(5) // 旧的非法取值也会被收敛
  })

  it('统计真实层数与节点数，能识别模型偷懒只给两层', () => {
    const shallow = [node('背景', [node('要点')])]
    expect(outlineDepth(shallow)).toBe(2)
    expect(countOutlineNodes(shallow)).toBe(2)

    const four = [node('章', [node('小节', [node('信息熵', [node('定义与条件')])])])]
    expect(outlineDepth(four)).toBe(4)
    expect(countOutlineNodes(four)).toBe(4)
    expect(outlineDepth([])).toBe(0)
    expect(countOutlineNodes([])).toBe(0)
  })
})
