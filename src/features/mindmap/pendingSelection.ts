/**
 * 跨视图「选中某张卡」的交接位。
 *
 * 搜索结果点击时脑图可能还没挂载（懒加载），直接派发事件会丢；
 * 先把 id 放在这里，工作区挂载后取走。
 */
let pendingCardId: string | null = null

export function requestCardSelection(cardId: string): void {
  pendingCardId = cardId
}

export function takePendingCardSelection(): string | null {
  const cardId = pendingCardId
  pendingCardId = null
  return cardId
}
