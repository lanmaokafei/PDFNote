/**
 * GitHub Release 正文生成。
 *
 * 约定：Release 正文必须写清「当前版本改了什么、加了什么」，
 * 不能只留一句安装说明。正文取自本次提交的说明（标题 + 逐条变更），
 * 提交说明为空时退回 README 里该版本的一句话概要。
 *
 * 独立成模块是为了能单测：发布脚本一旦 import 就会执行上传逻辑。
 */

/** 旧版脚本生成的正文开头，遇到它可以直接覆盖成新格式。 */
const LEGACY_PREFIX = '（macOS aarch64'

export function buildReleaseNotes({ version, digest, body = '', highlight = '' }) {
  const lines = String(body).split('\n')
  const subject = (lines[0] ?? '')
    .replace(/^(feat|fix|refactor|perf|docs|chore)(\([^)]*\))?:\s*/, '')
    .replace(new RegExp(`^${version.replace(/\./g, '\\.')}\\s*[-—:：]?\\s*`), '')
    .trim()
  const detail = lines.slice(1).join('\n').trim()
  const sections = [`## PDFNote ${version}`, '']
  if (subject) sections.push(subject, '')
  if (detail) {
    sections.push('### 本次变化', detail, '')
  } else if (highlight) {
    sections.push('### 本次变化', highlight, '')
  }
  sections.push(
    '### 安装',
    '把 DMG 里的 PDFNote.app 拖进 Applications 文件夹；ad-hoc 签名、未公证，首次打开需右键「打开」。',
    '',
    '### 校验',
    '```',
    `SHA-256: ${digest}`,
    '```',
  )
  return sections.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * 是否允许自动改写已有正文：
 * 空正文、旧模板（`PDFNote X.Y.Z（macOS aarch64…`）、本脚本生成的正文（`## PDFNote X.Y.Z`）可以；
 * 其余视为手工润色过，保持不动（要覆盖就显式传 --notes）。
 */
export function canAutoUpdateNotes(current, version) {
  const text = String(current ?? '').trim()
  if (!text) return true
  if (text.startsWith(`PDFNote ${version}${LEGACY_PREFIX}`)) return true
  return text.startsWith(`## PDFNote ${version}`)
}
