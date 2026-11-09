#!/usr/bin/env node
/**
 * 把本地签名打包的 DMG 同步到 GitHub Release。
 *
 * 发布流程（务必按顺序）：
 *   1. npm run build && npx tauri build --bundles app
 *   2. hdiutil 打包 DMG（带 Applications 快捷方式）并生成 .sha256
 *   3. git add -A && git commit && git push origin main
 *   4. npm run release:github   ← 本脚本
 *
 * 认证（按优先级）：GITHUB_TOKEN / GH_TOKEN 环境变量 → `gh auth token` →
 * ~/.config/pdfnote/github-token（纯文本，仅一行 token）。
 * 需要 repo 的 Contents: write 权限（classic PAT 的 repo scope 或
 * fine-grained PAT 的 Contents read/write）。
 *
 * 用法：
 *   node scripts/publish-github-release.mjs [--dry-run] [--replace]
 *        [--tag v0.19.0] [--file release/xxx.dmg] [--notes "..."] [--notes-file path]
 *        [--notes-only] [--keep-notes]
 *
 * Release 正文默认由「本次提交的标题 + 提交说明里的功能条目」生成，
 * 也就是当前版本改了什么、加了什么必须写进 Release，不能只留一句安装说明。
 *
 * --dry-run     只打印计划，不写入 GitHub（无需 token）
 * --replace     同名资产已存在但内容不一致时，删除旧资产后重新上传；
 *               不加该参数会直接报错，避免误覆盖线上包。
 * --notes-only  只补写 / 更新 Release 正文，不碰资产（用于给已发布的版本补说明）
 * --keep-notes  不自动改写正文（正文已被手工润色时用）
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, join, basename } from 'node:path'
import { buildReleaseNotes, canAutoUpdateNotes } from './releaseNotes.mjs'

const ROOT = resolve(import.meta.dirname, '..')
// 仅用于本地 mock 自测；正常发布不要设置这两个变量。
const API = process.env.GITHUB_API_BASE || 'https://api.github.com'
const UPLOAD = process.env.GITHUB_UPLOAD_BASE || 'https://uploads.github.com'

function parseArgs(argv) {
  const options = {
    tag: '', file: '', notes: '', notesFile: '', replace: false, dryRun: false,
    skipVerify: false, notesOnly: false, keepNotes: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--replace') options.replace = true
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--skip-verify') options.skipVerify = true
    else if (arg === '--notes-only') options.notesOnly = true
    else if (arg === '--keep-notes') options.keepNotes = true
    else if (arg === '--tag') options.tag = argv[++index] ?? ''
    else if (arg === '--file') options.file = argv[++index] ?? ''
    else if (arg === '--notes') options.notes = argv[++index] ?? ''
    else if (arg === '--notes-file') options.notesFile = argv[++index] ?? ''
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node scripts/publish-github-release.mjs [--dry-run] [--replace] [--notes-only] [--keep-notes] [--tag vX.Y.Z] [--file path.dmg] [--notes text] [--notes-file path]')
      process.exit(0)
    } else throw new Error(`未知参数: ${arg}`)
  }
  return options
}

function git(...args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
}

function remoteSlug() {
  const url = git('remote', 'get-url', 'origin')
  const match = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
  if (!match) throw new Error(`无法从 remote 解析 GitHub 仓库: ${url}`)
  return `${match[1]}/${match[2]}`
}

function readToken() {
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (fromEnv) return fromEnv.trim()
  try {
    const fromGh = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    if (fromGh?.trim()) return fromGh.trim()
  } catch { /* gh 未安装或未登录 */ }
  const tokenFile = join(homedir(), '.config', 'pdfnote', 'github-token')
  if (existsSync(tokenFile)) {
    const value = readFileSync(tokenFile, 'utf8').trim()
    if (value) return value
  }
  throw new Error(
    '缺少 GitHub token：请设置 GITHUB_TOKEN，或安装 gh 并登录，或把 token 写入 ' +
    `${tokenFile}（一行纯文本，chmod 600）。token 需要 Contents: write 权限。`,
  )
}

async function api(path, { token, method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pdfnote-release-script',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body } : {}),
  })
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`${method} ${path} → ${response.status}: ${detail.slice(0, 400)}`)
  }
  if (response.status === 204) return null
  return response.json()
}

async function uploadAsset({ token, slug, releaseId, file, name }) {
  const bytes = await readFile(file)
  const response = await fetch(
    `${UPLOAD}/repos/${slug}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'pdfnote-release-script',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(bytes.length),
      },
      body: bytes,
    },
  )
  if (!response.ok) {
    const detail = await response.text()
    throw new Error(`上传 ${name} → ${response.status}: ${detail.slice(0, 400)}`)
  }
  return response.json()
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/** 本次提交的完整说明：第一行是标题，其余行是「改了什么 / 加了什么」。 */
function commitBody() {
  return git('log', '-1', '--format=%B')
}

/** README 里当前版本那一条（用户视角的一句话概要），用作正文的后备来源。 */
function readmeHighlight(version) {
  try {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
    const line = readme
      .split('\n')
      .find((row) => row.startsWith('- **') && row.includes(`（${version}）`))
    if (!line) return ''
    return line
      .replace(/^- /, '')
      .replace(/\*\*/g, '')
      .replace(/^([^（]+)（[^）]+）：/, '$1：')
      .trim()
  } catch {
    return ''
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  const version = pkg.version
  const tag = options.tag || `v${version}`
  const dmg = resolve(ROOT, options.file || `release/PDFNote_${version}_aarch64.dmg`)
  const shaFile = `${dmg}.sha256`
  const slug = remoteSlug()
  const head = git('rev-parse', 'HEAD')

  for (const file of [dmg, shaFile]) {
    if (!existsSync(file)) throw new Error(`缺少文件: ${file}（先打包 DMG 并生成 .sha256）`)
  }

  // 本地校验：sha256 必须与 DMG 一致，DMG 必须通过 hdiutil verify。
  const bytes = await readFile(dmg)
  const digest = sha256(bytes)
  const declared = (await readFile(shaFile, 'utf8')).trim().split(/\s+/)[0]
  if (declared.toLowerCase() !== digest) {
    throw new Error(`SHA-256 不匹配：.sha256 记录 ${declared}，实际 ${digest}`)
  }
  if (!options.skipVerify) {
    try {
      execFileSync('hdiutil', ['verify', dmg], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (reason) {
      throw new Error(`hdiutil verify 失败: ${String(reason.stderr || reason).slice(0, 300)}`)
    }
  }

  // Release 正文：显式 --notes / --notes-file 优先，否则用本次提交说明生成。
  const explicitNotes = options.notesFile
    ? (await readFile(resolve(ROOT, options.notesFile), 'utf8')).trim()
    : options.notes.trim()
  const notes = explicitNotes || buildReleaseNotes({
    version,
    digest,
    body: commitBody(),
    highlight: readmeHighlight(version),
  })

  console.log(`仓库      : ${slug}`)
  console.log(`版本/标签 : ${version} / ${tag}`)
  console.log(`本地文件  : ${dmg} (${bytes.length} bytes)`)
  console.log(`SHA-256   : ${digest}`)
  console.log(`当前 HEAD : ${head}`)

  if (options.dryRun) {
    console.log('\n[dry-run] 计划：创建或复用 Release，写入下方正文，上传 DMG 与 .sha256（同名资产不一致时需 --replace）。')
    console.log(`\n----- Release 正文 -----\n${notes}\n-------------------------`)
    return
  }

  const token = readToken()
  let release
  try {
    release = await api(`/repos/${slug}/releases/tags/${encodeURIComponent(tag)}`, { token })
    console.log(`已有 Release: ${release.html_url}（${release.assets.length} 个资产）`)
    // annotated tag 的 ref 指向 tag 对象而不是提交，必须用 ^{} 解引用再比较。
    const tagSha = git('ls-remote', 'origin', `refs/tags/${tag}^{}`).split(/\s+/)[0]
      || git('ls-remote', 'origin', `refs/tags/${tag}`).split(/\s+/)[0]
    if (tagSha && tagSha !== head) {
      console.warn(`⚠ 远端 tag ${tag} 指向 ${tagSha.slice(0, 7)}，与本地 HEAD ${head.slice(0, 7)} 不同；请确认 release 对应的源码。`)
    }
    // 正文要写清这一版改了什么：空正文 / 旧模板 / 本脚本生成的正文直接刷新，手工润色的保持不动。
    if (!options.keepNotes && notes !== (release.body ?? '').trim()) {
      if (explicitNotes || canAutoUpdateNotes(release.body, version)) {
        release = await api(`/repos/${slug}/releases/${release.id}`, {
          token,
          method: 'PATCH',
          body: JSON.stringify({ body: notes }),
          headers: { 'Content-Type': 'application/json' },
        })
        console.log('已更新 Release 正文（本次版本的功能说明）')
      } else {
        console.log('已有正文像是手工润色过的，跳过改写（要覆盖请传 --notes）')
      }
    }
  } catch (error) {
    if (!String(error.message).includes('404')) throw error
    if (options.notesOnly) {
      throw new Error(`Release ${tag} 不存在，无法只补正文；去掉 --notes-only 走正常发布。`)
    }
    console.log('Release 不存在，将创建。')
    release = await api(`/repos/${slug}/releases`, {
      token,
      method: 'POST',
      body: JSON.stringify({
        tag_name: tag, name: tag, target_commitish: head, body: notes,
        draft: false, prerelease: false,
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    console.log(`已创建 Release: ${release.html_url}`)
  }

  if (options.notesOnly) {
    console.log(`\n完成（仅正文）：${release.html_url}`)
    return
  }

  for (const file of [dmg, shaFile]) {
    const name = basename(file)
    const size = (await stat(file)).size
    const existing = release.assets.find((asset) => asset.name === name)
    if (existing) {
      const digestMatches = name.endsWith('.sha256')
        || !existing.digest
        || existing.digest.replace(/^sha256:/, '') === digest
      if (existing.size === size && digestMatches) {
        console.log(`跳过 ${name}（同名资产内容一致）`)
        continue
      }
      if (!options.replace) {
        throw new Error(
          `${name} 在 Release 里已存在但内容不同（线上 ${existing.size} bytes / 本地 ${size} bytes）。` +
          '确认要覆盖请加 --replace。',
        )
      }
      await api(`/repos/${slug}/releases/assets/${existing.id}`, { token, method: 'DELETE' })
      console.log(`已删除旧资产 ${name}`)
    }
    const asset = await uploadAsset({ token, slug, releaseId: release.id, file, name })
    console.log(`已上传 ${asset.name} → ${asset.browser_download_url}`)
  }

  const final = await api(`/repos/${slug}/releases/tags/${encodeURIComponent(tag)}`, { token })
  console.log(`\n完成：${final.html_url}`)
  console.log(`资产：${final.assets.map((a) => `${a.name} (${a.size} bytes)`).join(', ')}`)
}

main().catch((error) => {
  console.error(`publish-github-release: ${error.message}`)
  process.exit(1)
})
