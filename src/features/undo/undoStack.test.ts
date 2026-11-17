import { beforeEach, describe, expect, it } from 'vitest'
import { clearUndo, pushUndo, redoLast, undoLast, undoState } from './undoStack'

describe('撤销栈', () => {
  beforeEach(() => {
    clearUndo()
  })

  it('后进先出：撤销按相反顺序执行', async () => {
    const calls: string[] = []
    pushUndo({ label: 'A', undo: () => { calls.push('undo-A') }, redo: () => { calls.push('redo-A') } })
    pushUndo({ label: 'B', undo: () => { calls.push('undo-B') }, redo: () => { calls.push('redo-B') } })

    expect(await undoLast()).toBe('B')
    expect(await undoLast()).toBe('A')
    expect(calls).toEqual(['undo-B', 'undo-A'])
    expect(await undoLast()).toBeNull()
  })

  it('撤销后可重做，重做顺序与撤销相反', async () => {
    const calls: string[] = []
    pushUndo({ label: 'A', undo: () => { calls.push('undo-A') }, redo: () => { calls.push('redo-A') } })
    pushUndo({ label: 'B', undo: () => { calls.push('undo-B') }, redo: () => { calls.push('redo-B') } })

    await undoLast()
    await undoLast()
    expect(await redoLast()).toBe('A')
    expect(await redoLast()).toBe('B')
    expect(calls).toEqual(['undo-B', 'undo-A', 'redo-A', 'redo-B'])
    expect(await redoLast()).toBeNull()
  })

  it('新操作会清空重做栈', async () => {
    pushUndo({ label: 'A', undo: () => undefined, redo: () => undefined })
    await undoLast()
    pushUndo({ label: 'C', undo: () => undefined, redo: () => undefined })
    expect(undoState()).toMatchObject({ undoLabel: 'C', redoLabel: '', redoDepth: 0 })
    expect(undoState().redoLabel).toBe('')
  })

  it('栈有上限，最老的记录会被丢掉', () => {
    for (let index = 0; index < 60; index += 1) {
      pushUndo({ label: `#${index}`, undo: () => undefined, redo: () => undefined })
    }
    const state = undoState()
    expect(state.undoDepth).toBe(40)
    expect(state.undoLabel).toBe('#59')
  })

  it('执行失败的那一步不会留在栈里', async () => {
    pushUndo({ label: 'bad', undo: () => { throw new Error('boom') }, redo: () => undefined })
    await expect(undoLast()).rejects.toThrow('boom')
    expect(undoState().undoDepth).toBe(0)
  })
})
