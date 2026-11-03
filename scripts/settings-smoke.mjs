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

// 填入配置后按钮可用；浏览器环境应给出明确失败原因（不是静默）
await page.fill('input[placeholder="http://127.0.0.1:11434/v1"]', 'http://127.0.0.1:11434/v1')
await page.fill('input[placeholder="qwen2.5vl:7b"]', 'qwen2.5vl:7b')
const testButton = page.locator('.settings-test-button')
if (!(await testButton.count())) problems.push('缺少测试连接按钮')
else {
  const disabled = await testButton.isDisabled()
  if (disabled) problems.push('填写配置后测试按钮仍禁用')
  await testButton.click()
  await page.waitForTimeout(500)
  const panelText = await page.locator('.settings-dialog').innerText()
  if (!panelText.includes('连接测试失败')) problems.push('测试连接未给出失败反馈')
}

// 关闭按钮可关闭
await page.locator('.settings-dialog button[aria-label="关闭设置"]').click()
await page.waitForSelector('.settings-dialog', { state: 'detached', timeout: 3000 })

await browser.close()
console.log(JSON.stringify({ problems, fields, title }, null, 2))
if (problems.length > 0) process.exitCode = 1
