/**
 * 公式识别失败的展示逻辑。
 *
 * 失败时状态栏只留一句摘要，完整错误（网关原文、任务号、补救方式）收进折叠详情；
 * 网关在 90 秒上限返回 504 时错误体里会带异步任务号，这里负责把它揪出来。
 */
const TASK_PATTERN = /(?:任务\s*|tasks\/)([A-Za-z0-9][A-Za-z0-9_-]{5,})/i

export function extractTaskNo(message: string): string {
  return message.match(TASK_PATTERN)?.[1] ?? ''
}

export interface AiFailurePresentation {
  /** 状态栏一行摘要。 */
  summary: string
  /** 折叠详情：完整错误 + 任务号 + 补救方式。 */
  detail: string
  /** 提取到的任务号，空字符串表示没有。 */
  taskNo: string
}

export function describeAiFailure(message: string, hasExcerpt: boolean): AiFailurePresentation {
  const taskNo = extractTaskNo(message)
  const detail = [
    message.trim(),
    '',
    taskNo
      ? `任务号：${taskNo}（仍可能已完成，可在「设置 → 按任务号取回结果」粘贴取回）`
      : '未从响应中取到任务号。',
    hasExcerpt ? '原文已写入卡片摘录，可直接编辑修正。' : '卡片已保存选区图像，可手动补录公式。',
  ].join('\n')

  return {
    summary: '公式识别未完成，已保留原文与选区图像。',
    detail,
    taskNo,
  }
}
