import { chromium } from 'playwright-core'
import { mkdir } from 'node:fs/promises'

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const output = '/tmp/pdfnote-ui'
await mkdir(output, { recursive: true })

const browser = await chromium.launch({ executablePath: chrome, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
const problems = []
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`)
})

await page.goto('http://127.0.0.1:1420/', { waitUntil: 'networkidle' })
await page.screenshot({ path: `${output}/library.png`, fullPage: true })

const views = [
  ['脑图', 'mindmap'],
  ['复习', 'review'],
  ['资料库', 'library'],
]

for (const [label, name] of views) {
  await page.getByRole('tab', { name: new RegExp(label) }).first().click()
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${output}/${name}.png`, fullPage: true })
}

await page.getByRole('button', { name: '备份与恢复' }).click()
await page.waitForTimeout(600)
await page.screenshot({ path: `${output}/backup.png`, fullPage: true })

const body = await page.locator('body').innerText()
for (const expected of ['本地', '备份', '资料库']) {
  if (!body.includes(expected)) problems.push(`missing text: ${expected}`)
}

console.log(JSON.stringify({ problems, screenshots: output }, null, 2))
await browser.close()
if (problems.length) process.exitCode = 1
