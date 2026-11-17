import { beforeEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_FSRS_SETTINGS,
  FSRS_STORAGE_KEY,
  readFsrsSettings,
  saveFsrsSettings,
  schedulerVersion,
} from './fsrsSettings'

function installStorage(): Storage {
  const map = new Map<string, string>()
  const stub = {
    get length() { return map.size },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => { map.delete(key) },
    setItem: (key: string, value: string) => { map.set(key, String(value)) },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: stub, configurable: true })
  return stub as unknown as Storage
}

describe('复习计划参数', () => {
  beforeEach(() => {
    installStorage().clear()
  })

  it('没有保存过就用默认值', () => {
    expect(readFsrsSettings()).toEqual(DEFAULT_FSRS_SETTINGS)
  })

  it('保存后能读回，并把值限制在合理区间', () => {
    const saved = saveFsrsSettings({ retention: 0.95, maximumInterval: 365, learningSteps: ['10m'] })
    expect(saved).toEqual({ retention: 0.95, maximumInterval: 365, learningSteps: ['10m'] })
    expect(readFsrsSettings()).toEqual(saved)

    expect(saveFsrsSettings({ retention: 1.6, maximumInterval: 0, learningSteps: ['10m'] }))
      .toMatchObject({ retention: 0.97, maximumInterval: 1 })
    expect(saveFsrsSettings({ retention: 0.1, maximumInterval: 99999, learningSteps: ['10m'] }))
      .toMatchObject({ retention: 0.7, maximumInterval: 36500 })
  })

  it('坏 JSON 与非法步骤退回默认值，不抛错', () => {
    globalThis.localStorage.setItem(FSRS_STORAGE_KEY, '{not json')
    expect(readFsrsSettings()).toEqual(DEFAULT_FSRS_SETTINGS)

    saveFsrsSettings({
      retention: 0.9,
      maximumInterval: 36500,
      // @ts-expect-error 故意传非法值，验证兜底
      learningSteps: ['abc', '1y'],
    })
    expect(readFsrsSettings().learningSteps).toEqual(DEFAULT_FSRS_SETTINGS.learningSteps)
  })

  it('调度器标识带上参数，便于区分复习记录', () => {
    saveFsrsSettings({ retention: 0.85, maximumInterval: 365, learningSteps: ['10m'] })
    expect(schedulerVersion()).toBe('ts-fsrs-5.4.2/r0.85/i365')
  })
})
