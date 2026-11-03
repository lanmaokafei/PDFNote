import { describe, expect, it } from 'vitest'
import { describeAiFailure, extractTaskNo } from './aiFailure'

describe('extractTaskNo', () => {
  it('reads the task number from a gateway 504 message', () => {
    const message =
      '识别服务返回 504 Gateway Timeout: {"error":{"message":"等待模型响应超时（90s），任务 20261103-3252 仍在执行"}}'
    expect(extractTaskNo(message)).toBe('20261103-3252')
  })

  it('reads the task number from a task url', () => {
    expect(extractTaskNo('可稍后经 /api/v1/tasks/20261103-3185 查询结果')).toBe('20261103-3185')
  })

  it('returns empty when the message has no task number', () => {
    expect(extractTaskNo('识别服务返回 500: model not found')).toBe('')
    // 长度不足的“任务 x”不算编号，避免误抓正文。
    expect(extractTaskNo('任务 完成')).toBe('')
  })
})

describe('describeAiFailure', () => {
  it('keeps the summary short and puts the gateway text into detail', () => {
    const result = describeAiFailure(
      '识别服务返回 504 Gateway Timeout，任务 20261103-3252 仍在服务端执行',
      true,
    )
    expect(result.summary).not.toContain('504')
    expect(result.summary.length).toBeLessThan(40)
    expect(result.detail).toContain('504 Gateway Timeout')
    expect(result.detail).toContain('20261103-3252')
    expect(result.detail).toContain('按任务号取回结果')
    expect(result.detail).toContain('原文已写入卡片摘录')
  })

  it('explains manual entry when no excerpt was kept', () => {
    const result = describeAiFailure('连接超时', false)
    expect(result.detail).toContain('手动补录公式')
    expect(result.detail).toContain('未从响应中取到任务号')
    expect(result.taskNo).toBe('')
  })
})
