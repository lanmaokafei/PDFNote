import { fsrs, type FSRS, type StepUnit } from 'ts-fsrs'

/**
 * 复习计划参数：请求保留率、最长间隔、学习步骤。
 *
 * 只存本机 localStorage（`pdfnote.fsrs`）——这些是「手感」偏好，
 * 不属于笔记数据，所以不写库、也不进备份；换电脑要重新设一次。
 */
export interface FsrsSettings {
  /** 期望记住的比例，0.7–0.97；越高复习越频繁。 */
  retention: number
  /** 单个间隔上限（天），防止成熟卡被排到几年后。 */
  maximumInterval: number
  /** 学习阶段的短步骤。 */
  learningSteps: StepUnit[]
}

export const FSRS_STORAGE_KEY = 'pdfnote.fsrs'
export const DEFAULT_FSRS_SETTINGS: FsrsSettings = {
  retention: 0.9,
  maximumInterval: 36500,
  learningSteps: ['1m', '10m'],
}

export const RETENTION_CHOICES = [0.8, 0.85, 0.9, 0.95] as const
export const INTERVAL_CHOICES = [180, 365, 3650, 36500] as const

export const LEARNING_STEP_CHOICES: Array<{ label: string; steps: StepUnit[] }> = [
  { label: '标准（1 分钟 / 10 分钟）', steps: ['1m', '10m'] },
  { label: '密集（1 / 5 / 10 分钟）', steps: ['1m', '5m', '10m'] },
  { label: '单步（10 分钟）', steps: ['10m'] },
]

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function clampRetention(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_FSRS_SETTINGS.retention
  return Math.min(0.97, Math.max(0.7, value))
}

function clampInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_FSRS_SETTINGS.maximumInterval
  return Math.min(36500, Math.max(1, Math.round(value)))
}

function readSteps(value: unknown): StepUnit[] {
  if (!Array.isArray(value)) return [...DEFAULT_FSRS_SETTINGS.learningSteps]
  // 只接受形如 1m / 10m / 1h / 1d 的步骤，其它值会让调度器抛错。
  const steps = value.filter(
    (item): item is StepUnit => typeof item === 'string' && /^\d+[smhd]$/u.test(item),
  )
  return steps.length > 0 ? steps : [...DEFAULT_FSRS_SETTINGS.learningSteps]
}

export function readFsrsSettings(): FsrsSettings {
  const raw = storage()?.getItem(FSRS_STORAGE_KEY)
  if (!raw) return { ...DEFAULT_FSRS_SETTINGS }
  try {
    const parsed = JSON.parse(raw) as Partial<FsrsSettings>
    return {
      retention: clampRetention(parsed.retention),
      maximumInterval: clampInterval(parsed.maximumInterval),
      learningSteps: readSteps(parsed.learningSteps),
    }
  } catch {
    return { ...DEFAULT_FSRS_SETTINGS }
  }
}

export function saveFsrsSettings(settings: FsrsSettings): FsrsSettings {
  const next: FsrsSettings = {
    retention: clampRetention(settings.retention),
    maximumInterval: clampInterval(settings.maximumInterval),
    learningSteps: readSteps(settings.learningSteps),
  }
  storage()?.setItem(FSRS_STORAGE_KEY, JSON.stringify(next))
  return next
}

let cachedKey = ''
let cached: FSRS | null = null

/** 按当前参数取调度器；参数没变就复用同一个实例。 */
export function currentScheduler(): FSRS {
  const settings = readFsrsSettings()
  const key = `${settings.retention}|${settings.maximumInterval}|${settings.learningSteps.join(',')}`
  if (cached && key === cachedKey) return cached
  cached = fsrs({
    request_retention: settings.retention,
    maximum_interval: settings.maximumInterval,
    learning_steps: settings.learningSteps,
  })
  cachedKey = key
  return cached
}

/** 写进 review_logs 的调度器标识：参数不同，复习记录的可比性就不同。 */
export function schedulerVersion(): string {
  const settings = readFsrsSettings()
  return `ts-fsrs-5.4.2/r${settings.retention.toFixed(2)}/i${settings.maximumInterval}`
}
