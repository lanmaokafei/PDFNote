import { describe, expect, it } from 'vitest'
import type { OcrLine } from '../../services/pdfnote'
import {
  buildTitleLinkIndex,
  cardKeywords,
  hitBBox,
  isTitleLinkIndexEmpty,
  normalizeKeyword,
  searchTitleLinks,
} from './titleLink'

const card = (id: string, question: string, link_aliases = '') => ({ id, question, link_aliases })

const line = (text: string, x = 0.1, y = 0.2, width = 0.6, height = 0.03): OcrLine => ({
  text, x, y, width, height, confidence: 1,
})

describe('normalizeKeyword', () => {
  it('接受单行 2–24 字符的文字', () => {
    expect(normalizeKeyword('心肌梗死')).toBe('心肌梗死')
    expect(normalizeKeyword('  STEMI  ')).toBe('STEMI')
    expect(normalizeKeyword('MI')).toBe('MI')
  })

  it('拒绝过短、过长、多行与纯标点', () => {
    expect(normalizeKeyword('心')).toBeNull()
    expect(normalizeKeyword('a'.repeat(25))).toBeNull()
    expect(normalizeKeyword('第一行\n第二行')).toBeNull()
    expect(normalizeKeyword('；；')).toBeNull()
    expect(normalizeKeyword('   ')).toBeNull()
  })
})

describe('cardKeywords', () => {
  it('标题与分号别名合并去重', () => {
    expect(cardKeywords(card('c1', '心肌梗死', 'MI; myocardial infarction；心肌梗死')))
      .toEqual(['心肌梗死', 'MI', 'myocardial infarction'])
  })

  it('长问题句不注册，别名仍可注册', () => {
    expect(cardKeywords(card('c1', '这是一句很长很长的问题描述超过二十四个字所以不该入字典', 'RCA')))
      .toEqual(['RCA'])
  })
})

describe('buildTitleLinkIndex + searchTitleLinks', () => {
  it('中文关键词在页面行内命中并换算子矩形', () => {
    const index = buildTitleLinkIndex([card('c1', '心肌梗死')])
    const hits = searchTitleLinks(index, [line('急性心肌梗死的诊断')])
    expect(hits).toHaveLength(1)
    expect(hits[0].keyword).toBe('心肌梗死')
    expect(hits[0].cardIds).toEqual(['c1'])
    expect(hits[0].bbox.y).toBe(0.2)
    expect(hits[0].bbox.x).toBeGreaterThan(0.1)
    expect(hits[0].bbox.width).toBeGreaterThan(0)
    expect(hits[0].bbox.x + hits[0].bbox.width).toBeLessThanOrEqual(0.7 + 1e-9)
  })

  it('拉丁关键词要求词边界且忽略大小写', () => {
    const index = buildTitleLinkIndex([card('c1', 'STEMI')])
    expect(searchTitleLinks(index, [line('inferior STEMI case')])).toHaveLength(1)
    expect(searchTitleLinks(index, [line('inferior stemi case')])).toHaveLength(1)
    expect(searchTitleLinks(index, [line('XSTEMIX')])).toHaveLength(0)
  })

  it('同一关键词聚合多张卡片', () => {
    const index = buildTitleLinkIndex([card('c1', '心肌梗死'), card('c2', '心肌梗死')])
    const hits = searchTitleLinks(index, [line('心肌梗死')])
    expect(hits).toHaveLength(1)
    expect(hits[0].cardIds).toEqual(['c1', 'c2'])
  })

  it('别名与标题命中同一张卡的不同位置', () => {
    const index = buildTitleLinkIndex([card('c1', '心肌梗死', 'MI')])
    const hits = searchTitleLinks(index, [line('心肌梗死 MI')])
    expect(hits).toHaveLength(2)
    expect(hits.every((hit) => hit.cardIds[0] === 'c1')).toBe(true)
  })

  it('无关键词字典为空，空行与无命中返回空数组', () => {
    const empty = buildTitleLinkIndex([])
    expect(isTitleLinkIndexEmpty(empty)).toBe(true)
    expect(searchTitleLinks(empty, [line('任何文本')])).toEqual([])
    const index = buildTitleLinkIndex([card('c1', '心肌梗死')])
    expect(isTitleLinkIndexEmpty(index)).toBe(false)
    expect(searchTitleLinks(index, [line('   '), line('毫无关系的内容')])).toEqual([])
  })

  it('hitBBox 在 Node 环境按字符比例换算', () => {
    const bbox = hitBBox(line('急性心肌梗死'), 2, 6)
    expect(bbox.x).toBeCloseTo(0.1 + 0.6 * (2 / 6), 6)
    expect(bbox.width).toBeCloseTo(0.6 * (4 / 6), 6)
    expect(bbox.height).toBe(0.03)
  })
})
