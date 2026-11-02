import { chromium } from 'playwright-core'

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await chromium.launch({ executablePath: chrome, headless: true })
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
const problems = []
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`))
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console: ${message.text()}`)
})

await page.goto('http://127.0.0.1:1420/', { waitUntil: 'networkidle' })
await page.waitForSelector('.app-shell')

async function openShellMenu(x = 60, y = 20) {
  await page.evaluate(({ x, y }) => {
    document.querySelector('.app-shell').dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true, clientX: x, clientY: y,
    }))
  }, { x, y })
  await page.waitForSelector('.context-menu')
  await page.locator('.context-menu-item').first().waitFor({ state: 'visible' })
}

// 1. WKWebView 原生 Reload 菜单应被接管，同时弹出应用兜底菜单
const guard = await page.evaluate(() => {
  const event = new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 40, clientY: 40,
  })
  document.querySelector('.app-shell').dispatchEvent(event)
  return event.defaultPrevented
})
if (!guard) problems.push('原生右键菜单未被阻止')
await page.waitForSelector('.context-menu')
await page.locator('.context-menu-item').first().waitFor({ state: 'visible' })
const labels = await page.locator('.context-menu-item').allInnerTexts()
for (const label of ['复制选中文字', '资料库', '知识脑图', '复习', '备份与恢复']) {
  if (!labels.some((text) => text.includes(label))) problems.push(`缺少菜单项: ${label}`)
}

// 2. ESC 关闭
await page.keyboard.press('Escape')
await page.waitForSelector('.context-menu', { state: 'detached' })

// 3. 输入框保留系统复制/粘贴菜单，且不弹应用菜单
const editable = await page.evaluate(() => {
  const input = document.querySelector('.library-search input')
  const event = new MouseEvent('contextmenu', {
    bubbles: true, cancelable: true, clientX: 100, clientY: 100,
  })
  input.dispatchEvent(event)
  return {
    defaultPrevented: event.defaultPrevented,
    menuOpen: Boolean(document.querySelector('.context-menu')),
  }
})
if (editable.defaultPrevented) problems.push('输入框右键被阻止，系统菜单丢失')
if (editable.menuOpen) problems.push('输入框上弹出了应用菜单')

// 4. 靠近右下角时菜单翻转并完全落在视口内
await page.mouse.click(1275, 795, { button: 'right' })
await page.waitForSelector('.context-menu')
const box = await page.locator('.context-menu').boundingBox()
const viewport = page.viewportSize()
if (!box || box.x < 0 || box.y < 0
  || box.x + box.width > viewport.width + 1
  || box.y + box.height > viewport.height + 1) {
  problems.push(`菜单超出视口: ${JSON.stringify(box)}`)
}

// 5. 点击菜单外部关闭
await page.mouse.click(5, 5, { button: 'left' })
await page.waitForSelector('.context-menu', { state: 'detached' })

// 6. 菜单项确实执行动作（切换工作区）
await openShellMenu()
const step6Menu = await page.evaluate(() => {
  const menu = document.querySelector('.context-menu')
  return menu ? menu.innerText : null
})
const clicked = await page.evaluate(() => {
  const items = Array.from(document.querySelectorAll('.context-menu-item'))
  const target = items.find((item) => item.textContent?.includes('复习'))
  if (!target) return false
  target.click()
  return true
})
if (!clicked) problems.push(`菜单项「复习」不可点击，当前菜单: ${step6Menu}`)
await page.waitForTimeout(350)
const bodyText = await page.locator('body').innerText()
if (!bodyText.includes('复习工作区')) problems.push('点击「复习」未切换工作区')

// 7. 键盘导航：方向键高亮，ESC 收起
await openShellMenu()
await page.keyboard.press('ArrowDown')
const activeCount = await page.locator('.context-menu-item.is-active').count()
if (activeCount !== 1) problems.push('方向键未高亮菜单项')
await page.keyboard.press('Escape')
await page.waitForSelector('.context-menu', { state: 'detached' })

// 8. 右键时重新读取 DOM 选区（文字层菜单依赖此函数）
const textSelection = await page.evaluate(async () => {
  const { readTextSelection } = await import('/src/features/pdf/textSelection.ts')
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:100px;top:100px;width:800px;height:600px;'
  const layer = document.createElement('div')
  layer.style.cssText = 'position:absolute;inset:0;'
  const line = document.createElement('div')
  line.style.cssText = 'position:absolute;left:5%;top:15%;font-size:26px;user-select:text;'
  const span = document.createElement('span')
  span.textContent = '信息系统项目管理师教程'
  line.appendChild(span)
  layer.appendChild(line)
  host.appendChild(layer)
  document.body.appendChild(host)

  const range = document.createRange()
  range.setStart(span.firstChild, 0)
  range.setEnd(span.firstChild, 4)
  const selection = window.getSelection()
  selection.removeAllRanges()
  selection.addRange(range)
  const info = readTextSelection(layer)

  // 跨层选区不能被误判为单层选区
  const other = document.createElement('span')
  other.textContent = '另一页'
  host.appendChild(other)
  const crossRange = document.createRange()
  crossRange.setStart(span.firstChild, 0)
  crossRange.setEnd(other.firstChild, 2)
  selection.removeAllRanges()
  selection.addRange(crossRange)
  const crossPage = readTextSelection(layer)

  selection.removeAllRanges()
  host.remove()
  return { info, crossPageIsNull: crossPage === null }
})
if (textSelection.info?.text !== '信息系统'
  || !textSelection.info.bbox
  || textSelection.info.bbox.width <= 0
  || textSelection.info.bbox.height <= 0) {
  problems.push(`选区读取异常: ${JSON.stringify(textSelection.info)}`)
}
if (!textSelection.crossPageIsNull) problems.push('跨页选区被误判为本页选区')

console.log(JSON.stringify({ problems, guard, editable, box, textSelection }, null, 2))
await browser.close()
if (problems.length) process.exitCode = 1
