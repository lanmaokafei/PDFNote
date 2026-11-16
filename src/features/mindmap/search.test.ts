import { describe, expect, it } from 'vitest'
import { searchCards } from './search'

const cards = [
  { id: 'a', question: '心肌梗死的再灌注时间窗', excerpt: '', user_note: '' },
  { id: 'b', question: '再灌注策略', excerpt: '心肌梗死需要尽快再灌注', user_note: '' },
  { id: 'c', question: '', excerpt: '', user_note: '笔记里提到心肌梗死' },
  { id: 'd', question: '无关卡片', excerpt: '', user_note: '' },
]

describe('脑图搜索', () => {
  it('问题命中优先于摘录，摘录优先于笔记', () => {
    expect(searchCards(cards, '心肌梗死').map((hit) => hit.id)).toEqual(['a', 'b', 'c'])
  })

  it('多个关键词要求全部命中（AND）', () => {
    expect(searchCards(cards, '心肌梗死 时间窗').map((hit) => hit.id)).toEqual(['a'])
    expect(searchCards(cards, '心肌梗死 不存在')).toEqual([])
  })

  it('空查询返回空，不把整张画布列出来', () => {
    expect(searchCards(cards, '')).toEqual([])
    expect(searchCards(cards, '   ')).toEqual([])
  })

  it('忽略大小写，且同一字段越靠前分越高', () => {
    const list = [
      { id: 'late', question: '再灌注与心肌梗死', excerpt: '', user_note: '' },
      { id: 'early', question: '心肌梗死与再灌注', excerpt: '', user_note: '' },
    ]
    expect(searchCards(list, '心肌梗死').map((hit) => hit.id)).toEqual(['early', 'late'])
    expect(searchCards([{ id: 'x', question: 'ATP 与 atp', excerpt: '', user_note: '' }], 'atp')).toHaveLength(1)
  })

  it('上限生效', () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      id: `c${index}`, question: `关键词 ${index}`, excerpt: '', user_note: '',
    }))
    expect(searchCards(many, '关键词', 3)).toHaveLength(3)
  })
})
