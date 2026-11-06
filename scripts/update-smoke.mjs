import { chromium } from 'playwright-core'

/**
 * 软件更新链路冒烟（0.32.0）：mock Tauri IPC 驱动
 *   自动检测 → 弹出升级提示 →「稍后」记忆 → 手动检查 → 下载进度 → 下载完成 → 点击升级 → 安装器被调起。
 * 运行前需 dev server（npm run dev -- --host 127.0.0.1）。
 */
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await chromium.launch({ executablePath: chrome, headless: true })
const problems = []

const AVAILABLE_INFO = {
  updateAvailable: true,
  currentVersion: '0.31.0',
  latestVersion: '0.32.0',
  releaseNotes: 'PDFNote 0.32.0\n- 新增在线检测升级：检查 GitHub Releases、下载进度、SHA-256 校验、点击升级。',
  releaseUrl: 'https://github.com/lanmaokafei/PDFNote/releases/tag/v0.32.0',
  downloadUrl: 'https://github.com/lanmaokafei/PDFNote/releases/download/v0.32.0/PDFNote_0.32.0_aarch64.dmg',
  downloadSize: 11_000_000,
  checksumUrl: 'https://github.com/lanmaokafei/PDFNote/releases/download/v0.32.0/PDFNote_0.32.0_aarch64.dmg.sha256',
}

const context = await browser.newContext({ viewport: { width: 1180, height: 820 } })
const page = await context.newPage()
page.on('pageerror', (error) => problems.push(`pageerror: ${error.stack ?? error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`)
})

await page.addInitScript((availableInfo) => {
  const mode = { value: 'available' }
  window.__updateMode = mode
  const eventListeners = {}
  window.__eventListeners = eventListeners
  window.__installerCalls = []
  window.__quitCalls = 0
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined }
  const handlers = {
    get_bootstrap_status: () => ({ database_ready: true, schema_version: 9, document_count: 0, card_count: 0 }),
    list_cards: () => [],
    list_documents: () => [],
    auto_backup: () => null,
    get_ai_settings: () => ({ baseUrl: '', model: '', apiKey: '', timeoutSecs: 120 }),
    get_app_version: () => '0.31.0',
    test_ai_connection: () => ({
      latencyMs: 69,
      models: ['qwen2.5vl:7b', 'llava:13b', 'minicpm-v'],
      modelFound: true,
      via: 'models',
    }),
    check_for_update: () => {
      if (mode.value === 'fail') return Promise.reject(new Error('模拟网络失败：无法连接 GitHub Releases'))
      if (mode.value === 'upToDate') {
        return Promise.resolve({ ...availableInfo, updateAvailable: false, latestVersion: '0.31.0', downloadUrl: '', downloadSize: 0, checksumUrl: '' })
      }
      return Promise.resolve({ ...availableInfo })
    },
    // 下载时分 4 档推送进度事件，模拟真实的流式下载。
    download_update: async (args) => {
      if (!args?.info?.downloadUrl) throw new Error('mock download_update 缺少 info')
      const total = 11_000_000
      for (const downloaded of [2_750_000, 6_050_000, 8_800_000, total]) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        const listener = eventListeners['update-download-progress']
        if (listener) listener({ event: 'update-download-progress', id: 1, payload: { downloaded, total } })
      }
      return '/tmp/PDFNote_0.32.0_aarch64.dmg'
    },
    open_update_installer: (args) => {
      window.__installerCalls.push(args?.path ?? '')
      return null
    },
    quit_app: () => {
      window.__quitCalls += 1
      return null
    },
    'plugin:event|listen': (args) => {
      eventListeners[args.event] = args.handler
      return 1
    },
    'plugin:event|unlisten': (args) => {
      delete eventListeners[args.event]
      return null
    },
  }
  window.__TAURI_INTERNALS__ = {
    invoke: (command, args) => {
      const handler = handlers[command]
      if (!handler) return Promise.resolve(null)
      try {
        return Promise.resolve(handler(args))
      } catch (error) {
        return Promise.reject(error)
      }
    },
    transformCallback: (callback) => callback,
  }
}, AVAILABLE_INFO)

const base = 'http://127.0.0.1:1420/'

// ── 阶段 1：启动后自动检测 → 弹出升级提示 →「稍后」写入版本记忆 ──────────────
await page.goto(base, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.app-shell')
await page.waitForSelector('.update-dialog', { timeout: 15_000 })
{
  const text = await page.locator('.update-dialog').innerText()
  if (!text.includes('发现新版本 v0.32.0')) problems.push(`自动提示缺少新版信息：${text.slice(0, 120)}`)
  if (!text.includes('当前 v0.31.0')) problems.push('自动提示缺少当前版本')
  if (!text.includes('10.5 MB')) problems.push(`自动提示缺少包体大小：${text.slice(0, 120)}`)
  // 更新说明可展开
  await page.locator('.update-notes summary').click()
  const notes = await page.locator('.update-notes pre').innerText()
  if (!notes.includes('在线检测升级')) problems.push('更新说明内容缺失')
  await page.locator('.update-dialog button', { hasText: '稍后' }).click()
  await page.waitForSelector('.update-dialog', { state: 'detached', timeout: 3000 })
  const dismissed = await page.evaluate(() => localStorage.getItem('pdfnote.update.dismissedVersion'))
  if (dismissed !== '0.32.0') problems.push(`「稍后」未写入版本记忆：${dismissed}`)
}

// ── 阶段 2：同一版本的自动提示不再弹出 ─────────────────────────────────────
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('.app-shell')
await page.waitForTimeout(10_500)
{
  const stillOpen = await page.locator('.update-dialog').count()
  if (stillOpen !== 0) problems.push('「稍后」后自动提示仍弹出')
}

// ── 阶段 3：设置里手动检查（不受「稍后」限制）→ 下载进度 → 完成 → 点击升级 ──
await page.locator('.app-top button[aria-label="设置"]').click()
await page.waitForSelector('.settings-dialog')
{
  const versionText = await page.locator('.settings-update').innerText()
  if (!versionText.includes('当前版本 v0.31.0')) problems.push(`设置页版本显示异常：${versionText}`)
}
await page.locator('[data-testid="settings-check-update"]').click()
await page.waitForSelector('.update-dialog')
{
  const text = await page.locator('.update-dialog').innerText()
  if (!text.includes('发现新版本 v0.32.0')) problems.push('手动检查未发现新版本')
}
await page.locator('.update-dialog button', { hasText: '下载升级' }).click()
await page.waitForSelector('.update-progress', { timeout: 3000 })
// 下载中应出现进度百分比，且中途能采到 <100% 的进行态
{
  const mid = await page.waitForFunction(() => {
    const bar = document.querySelector('.update-progress [role="progressbar"]')
    return bar ? Number(bar.getAttribute('aria-valuenow')) : 0
  }, undefined, { timeout: 4000 }).then((handle) => handle.jsonValue()).catch(() => 0)
  if (!(mid > 0 && mid < 100)) problems.push(`下载进度异常：${mid}`)
}
await page.waitForSelector('.update-dialog button:has-text("立即升级")', { timeout: 8000 })
{
  const text = await page.locator('.update-dialog').innerText()
  if (!text.includes('下载完成并通过 SHA-256 校验')) problems.push(`下载完成提示缺失：${text.slice(0, 150)}`)
}
await page.locator('.update-dialog button', { hasText: '立即升级' }).click()
await page.waitForTimeout(400)
{
  const calls = await page.evaluate(() => window.__installerCalls)
  if (!Array.isArray(calls) || calls.length !== 1 || calls[0] !== '/tmp/PDFNote_0.32.0_aarch64.dmg') {
    problems.push(`安装器调用异常：${JSON.stringify(calls)}`)
  }
  const text = await page.locator('.update-dialog').innerText()
  if (!text.includes('安装器已打开')) problems.push(`升级完成提示缺失：${text.slice(0, 150)}`)
  if (!text.includes('应用将自动退出')) problems.push('缺少自动退出提示')
  if (!(await page.locator('.update-dialog button', { hasText: '立即退出' }).count())) {
    problems.push('缺少「立即退出」按钮')
  }
}
// 打开安装器约 2 秒后必须调用 quit_app：运行中的 app 会让 Finder 拒绝覆盖安装。
await page.waitForTimeout(2300)
{
  const quitCalls = await page.evaluate(() => window.__quitCalls)
  if (quitCalls !== 1) problems.push(`安装器打开后未自动退出应用：quit_app 调用 ${quitCalls} 次`)
}
await page.locator('.update-dialog button[aria-label="关闭更新提示"]').click()
await page.waitForSelector('.update-dialog', { state: 'detached', timeout: 3000 })
// 设置面板在升级流程后仍开着，先关掉，阶段 4 重新走完整入口。
await page.locator('.settings-dialog button[aria-label="关闭设置"]').click()
await page.waitForSelector('.settings-dialog', { state: 'detached', timeout: 3000 })

// ── 阶段 4：已是最新 → 明确提示；网络失败 → 错误 + 重试入口 ─────────────────
await page.evaluate(() => { window.__updateMode.value = 'upToDate' })
await page.locator('.app-top button[aria-label="设置"]').click()
await page.waitForSelector('.settings-dialog')
await page.locator('[data-testid="settings-check-update"]').click()
await page.waitForSelector('.update-dialog')
{
  const text = await page.locator('.update-dialog').innerText()
  if (!text.includes('已是最新版本（0.31.0）')) problems.push(`最新版提示异常：${text.slice(0, 120)}`)
}
await page.locator('.update-dialog button', { hasText: '关闭' }).click()
await page.waitForSelector('.update-dialog', { state: 'detached', timeout: 3000 })

await page.evaluate(() => { window.__updateMode.value = 'fail' })
await page.locator('[data-testid="settings-check-update"]').click()
await page.waitForSelector('.update-dialog')
{
  const text = await page.locator('.update-dialog').innerText()
  if (!text.includes('模拟网络失败')) problems.push(`失败提示异常：${text.slice(0, 120)}`)
  if (!text.includes('重新检查')) problems.push('失败后缺少重新检查入口')
}
await page.locator('.update-dialog button', { hasText: '关闭' }).click()
await page.waitForSelector('.update-dialog', { state: 'detached', timeout: 3000 })

// ── 阶段 4.5：设置页细节——按钮规格一致；测试连接命中模型后仍显示模型列表 ────
{
  const height = await page.locator('[data-testid="settings-check-update"]')
    .evaluate((el) => getComputedStyle(el).height)
  if (height !== '32px') problems.push(`检查更新按钮高度与其他按钮不一致：${height}`)
  await page.fill('input[placeholder="http://127.0.0.1:11434/v1"]', 'http://127.0.0.1:11434/v1')
  await page.fill('input[placeholder="qwen2.5vl:7b"]', 'qwen2.5vl:7b')
  await page.locator('.settings-dialog footer .settings-test-button').first().click()
  await page.waitForTimeout(500)
  const text = await page.locator('.settings-dialog').innerText()
  if (!text.includes('✓ 服务可用')) problems.push(`测试连接成功状态缺失：${text.slice(0, 120)}`)
  if (!text.includes('耗时 69ms')) problems.push('测试连接耗时信息缺失')
  if (!text.includes('可用模型：')) problems.push('模型命中时未显示可用模型列表')
  if (!text.includes('llava:13b')) problems.push(`模型列表内容缺失：${text.slice(0, 160)}`)
}
await context.close()

// ── 阶段 5：浏览器（非 Tauri）环境 → 明确报错而不是崩溃 ────────────────────
{
  const web = await browser.newPage({ viewport: { width: 1180, height: 820 } })
  await web.goto(base, { waitUntil: 'domcontentloaded' })
  await web.waitForSelector('.app-shell')
  await web.locator('.app-top button[aria-label="设置"]').click()
  await web.waitForSelector('.settings-dialog')
  await web.locator('[data-testid="settings-check-update"]').click()
  await web.waitForSelector('.update-dialog', { timeout: 5000 })
  const text = await web.locator('.update-dialog').innerText()
  if (!text.includes('桌面应用中运行')) problems.push(`浏览器环境报错异常：${text.slice(0, 120)}`)
  await web.close()
}

await browser.close()
console.log(JSON.stringify({ problems }, null, 2))
if (problems.length > 0) process.exitCode = 1
