/** 跨库搜索点标签时的交接位：卡片盒是懒加载，事件可能早于监听。 */
let pendingTag: string | null = null

export function requestBoardFilter(tag: string): void {
  pendingTag = tag
}

export function takeBoardFilter(): string | null {
  const tag = pendingTag
  pendingTag = null
  return tag
}
