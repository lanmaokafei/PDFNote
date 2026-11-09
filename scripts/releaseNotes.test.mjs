import { describe, expect, it } from 'vitest'
import { buildReleaseNotes, canAutoUpdateNotes } from './releaseNotes.mjs'

const digest = '6ae823241ee7dc130d1fb2646a96a1163e456fae8496c359c27c1137e71f4209'

describe('Release 正文生成', () => {
  it('把提交标题里的类型前缀和版本号去掉，并保留功能条目', () => {
    const notes = buildReleaseNotes({
      version: '0.39.0',
      digest,
      body: [
        'feat(cloze): 0.39.0 文档回忆挖空填空',
        '',
        '文档回忆在「整块遮挡」与「揭示」之间补一层主动回忆。',
        '',
        '- 挖空规则纯函数：公式不挖、泛化词不挖。',
        '- 答错标红但不揭示，全对才自动揭示。',
      ].join('\n'),
    })
    expect(notes).toContain('## PDFNote 0.39.0')
    expect(notes).toContain('文档回忆挖空填空')
    expect(notes).not.toContain('feat(cloze)')
    expect(notes).not.toContain('0.39.0 文档回忆挖空填空')
    expect(notes).toContain('### 本次变化')
    expect(notes).toContain('- 答错标红但不揭示，全对才自动揭示。')
  })

  it('提交说明只有标题时退回 README 的版本概要', () => {
    const notes = buildReleaseNotes({
      version: '0.40.0',
      digest,
      body: 'feat(board): 0.40.0 看板支持拖拽排序',
      highlight: '看板支持拖拽排序：列内顺序会写回卡片，刷新后保持。',
    })
    expect(notes).toContain('### 本次变化')
    expect(notes).toContain('看板支持拖拽排序：列内顺序会写回卡片')
  })

  it('正文一定带安装说明与 SHA-256，且不留多余空行', () => {
    const notes = buildReleaseNotes({ version: '0.39.0', digest, body: 'feat: 0.39.0 挖空填空\n\n- 一项' })
    expect(notes).toContain('### 安装')
    expect(notes).toContain('Applications')
    expect(notes).toContain(`SHA-256: ${digest}`)
    expect(notes).not.toMatch(/\n{3,}/)
    expect(notes.endsWith('```')).toBe(true)
  })

  it('空提交说明也不会生成只有安装步骤的空壳正文', () => {
    const notes = buildReleaseNotes({ version: '0.39.0', digest, body: '' })
    expect(notes).toContain('## PDFNote 0.39.0')
    // 没有标题也没有 README 概要时，仍然保留校验信息，但不编造功能
    expect(notes).not.toContain('### 本次变化')
  })
})

describe('正文能否自动改写', () => {
  it('空正文、旧模板、本脚本生成的正文可以覆盖', () => {
    expect(canAutoUpdateNotes('', '0.39.0')).toBe(true)
    expect(canAutoUpdateNotes('PDFNote 0.39.0（macOS aarch64，ad-hoc 签名）', '0.39.0')).toBe(true)
    expect(canAutoUpdateNotes('## PDFNote 0.39.0\n\n挖空填空', '0.39.0')).toBe(true)
  })

  it('手工润色过或别的版本的正文保持不动', () => {
    expect(canAutoUpdateNotes('本次更新修了一堆小问题，详见 commit。', '0.39.0')).toBe(false)
    expect(canAutoUpdateNotes('## PDFNote 0.38.0\n\n画布涂鸦', '0.39.0')).toBe(false)
  })
})
