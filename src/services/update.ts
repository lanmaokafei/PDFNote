import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { isTauriRuntime } from './pdfnote'

/** 一次更新检查的结果（Rust `update::UpdateInfo`）。 */
export interface UpdateInfo {
  updateAvailable: boolean
  currentVersion: string
  latestVersion: string
  releaseNotes: string
  releaseUrl: string
  downloadUrl: string
  downloadSize: number
  checksumUrl: string
}

/** 下载进度（Rust `update::DownloadProgress`）。 */
export interface DownloadProgress {
  downloaded: number
  total: number
}

/** 与 Rust `update::UPDATE_PROGRESS_EVENT` 保持一致。 */
export const UPDATE_PROGRESS_EVENT = 'update-download-progress'

const desktopOnly = () => {
  if (!isTauriRuntime()) throw new Error('此操作需要在 PDFNote 桌面应用中运行')
}

/** 当前应用版本号（不联网）。 */
export async function getAppVersion(): Promise<string> {
  if (!isTauriRuntime()) return ''
  return invoke('get_app_version')
}

/** 检查 GitHub Releases 是否有新版本。 */
export async function checkForUpdate(): Promise<UpdateInfo> {
  desktopOnly()
  return invoke('check_for_update')
}

/** 下载更新安装包，返回本地 DMG 路径；进度经 UPDATE_PROGRESS_EVENT 推送。 */
export async function downloadUpdate(info: UpdateInfo): Promise<string> {
  desktopOnly()
  return invoke('download_update', { info })
}

/** 打开已下载并校验过的 DMG 安装器。 */
export async function openUpdateInstaller(path: string): Promise<void> {
  desktopOnly()
  return invoke('open_update_installer', { path })
}

/** 订阅下载进度；返回取消订阅函数。 */
export function onUpdateProgress(
  handler: (progress: DownloadProgress) => void,
): Promise<() => void> {
  if (!isTauriRuntime()) return Promise.resolve(() => undefined)
  return listen<DownloadProgress>(UPDATE_PROGRESS_EVENT, (event) => {
    handler(event.payload)
  })
}

/** 字节数转人类可读文本（下载进度显示用）。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`
}

/** 下载进度百分比（0–100）；总量未知时返回 0。 */
export function progressPercent(downloaded: number, total: number): number {
  if (!Number.isFinite(downloaded) || !Number.isFinite(total) || total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((downloaded / total) * 100)))
}

/** 「稍后」的版本记忆键：同版本只自动提示一次，手动「检查更新」不受限。 */
const DISMISSED_KEY = 'pdfnote.update.dismissedVersion'

/**
 * 启动后的自动检查：有新版且用户没对该版本点过「稍后」时返回更新信息，否则 null。
 * 网络异常时静默返回 null，不打扰阅读。
 */
export async function autoCheckUpdate(): Promise<UpdateInfo | null> {
  try {
    const info = await checkForUpdate()
    if (!info.updateAvailable) return null
    try {
      if (localStorage.getItem(DISMISSED_KEY) === info.latestVersion) return null
    } catch {
      /* 读不到记忆则照常提示 */
    }
    return info
  } catch {
    return null
  }
}

/** 记住「稍后」的版本，下次启动不再自动弹。 */
export function rememberDismissedVersion(version: string): void {
  try {
    localStorage.setItem(DISMISSED_KEY, version)
  } catch {
    /* 存不下也不阻塞 */
  }
}
