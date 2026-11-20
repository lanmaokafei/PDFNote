import { describe, expect, it } from 'vitest'
import { mergeAiAnalysis, stripAiAnalysis } from './aiNote'

describe('AI 解析去重', () => {
  it('重复解析时替换旧段而不是叠加', () => {
    const first = mergeAiAnalysis('我的笔记', '第一次解析')
    const second = mergeAiAnalysis(first, '第二次解析')
    expect(second).toBe('我的笔记\n\n【AI 解析】\n第二次解析')
    expect(second.match(/【AI 解析】/gu)).toHaveLength(1)
  })

  it('没有用户笔记时只留解析段', () => {
    expect(mergeAiAnalysis('', '解析内容')).toBe('【AI 解析】\n解析内容')
  })

  it('去掉标记后的所有内容（包括手工追加的旧段）', () => {
    expect(stripAiAnalysis('笔记\n\n【AI 解析】\n旧内容\n还有一行')).toBe('笔记')
  })

  it('没有标记时原样保留并去掉首尾空白', () => {
    expect(stripAiAnalysis('  纯笔记  ')).toBe('纯笔记')
  })

  it('空解析不会破坏已有内容', () => {
    expect(mergeAiAnalysis('笔记', '   ')).toBe('笔记')
  })
})
