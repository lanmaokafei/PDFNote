import { chromium } from 'playwright-core'

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await chromium.launch({ executablePath: chrome, headless: true })
const page = await browser.newPage({ viewport: { width: 1180, height: 820 } })
const problems = []

await page.goto('http://127.0.0.1:1420/', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.app-shell')

// 顶栏齿轮 → 设置对话框
await page.locator('.app-top button[aria-label="设置"]').click()
await page.waitForSelector('.settings-dialog', { timeout: 5000 })

const fields = await page.locator('.settings-dialog input').count()
if (fields !== 3) problems.push(`设置字段数量异常：${fields}`)

const title = await page.locator('#settings-title').innerText()
if (!title.includes('AI 识别')) problems.push(`标题异常：${title}`)

// 非 Tauri 环境应显示明确错误，而不是空白或崩溃
const statusText = await page.locator('.settings-dialog').innerText()
if (!statusText.includes('桌面应用中运行')) problems.push('浏览器环境未提示需要桌面应用')

// ESC/关闭按钮可关闭
await page.locator('.settings-dialog button[aria-label="关闭设置"]').click()
await page.waitForSelector('.settings-dialog', { state: 'detached', timeout: 3000 })

await browser.close()
console.log(JSON.stringify({ problems, fields, title }, null, 2))
if (problems.length > 0) process.exitCode = 1
