/**
 * 应用级撤销栈。
 *
 * 只记录「可以安全重放」的操作：每一步自带 undo / redo 两个函数，
 * 调用方负责把「改了什么」变成可执行的动作（写库 + 刷新）。
 * 栈只存在内存里：重启后清空，避免用旧快照覆盖后来改的数据。
 */

export interface UndoEntry {
  /** 给用户看的动作名，例如「大纲结构调整」「擦除笔迹」。 */
  label: string
  undo: () => Promise<void> | void
  redo: () => Promise<void> | void
}

export const UNDO_CHANGED_EVENT = 'pdfnote:undo-changed'
const LIMIT = 40

let undoStack: UndoEntry[] = []
let redoStack: UndoEntry[] = []
let running = false

function notify(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(UNDO_CHANGED_EVENT, {
    detail: {
      undoLabel: undoStack.at(-1)?.label ?? '',
      redoLabel: redoStack.at(-1)?.label ?? '',
      undoDepth: undoStack.length,
      redoDepth: redoStack.length,
    },
  }))
}

/** 记录一步可撤销操作；新的操作会清空重做栈。 */
export function pushUndo(entry: UndoEntry): void {
  undoStack.push(entry)
  if (undoStack.length > LIMIT) undoStack.shift()
  redoStack = []
  notify()
}

export function undoState(): { undoLabel: string; redoLabel: string; undoDepth: number; redoDepth: number } {
  return {
    undoLabel: undoStack.at(-1)?.label ?? '',
    redoLabel: redoStack.at(-1)?.label ?? '',
    undoDepth: undoStack.length,
    redoDepth: redoStack.length,
  }
}

export function clearUndo(): void {
  undoStack = []
  redoStack = []
  notify()
}

/** 撤销一步，返回动作名；栈空或正在执行时返回 null。 */
export async function undoLast(): Promise<string | null> {
  if (running) return null
  const entry = undoStack.pop()
  if (!entry) return null
  running = true
  try {
    await entry.undo()
    redoStack.push(entry)
    return entry.label
  } finally {
    // 失败时这一步已经从栈里弹出：避免用户反复按 ⌘Z 卡在同一条坏记录上。
    running = false
    notify()
  }
}

export async function redoLast(): Promise<string | null> {
  if (running) return null
  const entry = redoStack.pop()
  if (!entry) return null
  running = true
  try {
    await entry.redo()
    undoStack.push(entry)
    return entry.label
  } finally {
    running = false
    notify()
  }
}
