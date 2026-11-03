import { chromium } from 'playwright-core'

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await chromium.launch({ executablePath: chrome, headless: true })
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })

await page.setContent(`<!doctype html>
<html><head><style>
  body { margin: 0; font-family: -apple-system, "PingFang SC", sans-serif; }
  .page { position: relative; width: 800px; height: 600px; background: #fff; }
  .canvas { position: absolute; inset: 0; z-index: 0; background: #fafafa; }
  .layer { position: absolute; inset: 0; z-index: 1; overflow: hidden; pointer-events: auto; user-select: none; }
  .line { position: absolute; white-space: pre; line-height: 1; color: transparent; user-select: text; }
  .line > span { display: inline-block; white-space: pre; vertical-align: top; transform-origin: left top; }
  .line::selection, .line > span::selection { color: transparent; -webkit-text-fill-color: transparent; caret-color: transparent; background: rgba(86,156,204,.32); }
  .svg-layer { position: absolute; inset: 0; z-index: 2; pointer-events: none; }
</style></head><body>
  <div class="page" id="page">
    <div class="canvas"></div>
    <div class="layer" id="layer"></div>
    <div class="svg-layer"></div>
  </div>
</body></html>`)

const geometry = await page.evaluate(() => {
  const lines = [
    { text: '信息系统项目管理师教程', x: 0.05, y: 0.15, width: 0.5, height: 0.05 },
    { text: '信息熵用来度量系统的不确定性', x: 0.05, y: 0.30, width: 0.6, height: 0.05 },
  ]
  const layer = document.getElementById('layer')
  const measure = document.createElement('canvas').getContext('2d')
  for (const line of lines) {
    const fontSize = 600 * line.height * 0.86
    measure.font = `${fontSize}px -apple-system, "PingFang SC", sans-serif`
    const natural = Math.max(1, measure.measureText(line.text).width)
    const scaleX = Math.min(6, Math.max(0.15, (line.width * 800) / natural))
    const row = document.createElement('div')
    row.className = 'line'
    row.style.cssText = `left:${line.x * 100}%;top:${line.y * 100}%;width:${line.width * 100}%;height:${line.height * 100}%;font-size:${fontSize}px`
    const span = document.createElement('span')
    span.style.transform = `scaleX(${scaleX})`
    span.textContent = line.text
    row.appendChild(span)
    layer.appendChild(row)
  }
  return lines.map((line) => ({ text: line.text, top: line.y * 600, left: line.x * 800 }))
})

// 模拟 Word 式拖选：从第一行靠左拖到中部
const box = await page.locator('#page').boundingBox()
const startX = box.x + 50
const startY = box.y + geometry[0].top + 14
await page.mouse.move(startX, startY)
await page.mouse.down()
await page.mouse.move(startX + 230, startY, { steps: 8 })
await page.mouse.up()

const selected = await page.evaluate(() => {
  const selection = window.getSelection()
  const text = selection ? selection.toString().trim() : ''
  if (!text || !selection || selection.rangeCount === 0) return { text: '' }
  const rect = selection.getRangeAt(0).getBoundingClientRect()
  const pageRect = document.getElementById('page').getBoundingClientRect()
  return {
    text,
    bbox: {
      x: (rect.left - pageRect.left) / pageRect.width,
      y: (rect.top - pageRect.top) / pageRect.height,
      width: rect.width / pageRect.width,
      height: rect.height / pageRect.height,
    },
  }
})

// 选区字形必须保持透明，否则拉伸后的 DOM 字形会与 PDF 真实字形重影。
const selectionStyle = await page.evaluate(() => {
  const span = document.querySelector('.line > span')
  if (!span) return null
  const style = getComputedStyle(span, '::selection')
  return { color: style.color, fillColor: style.webkitTextFillColor }
})

await browser.close()

const ok = selected.text.length > 0
  && geometry[0].text.includes(selected.text)
  && selected.bbox.width > 0
  && selected.bbox.height > 0
  && !!selectionStyle
  && selectionStyle.color === 'rgba(0, 0, 0, 0)'
console.log(JSON.stringify({ ok, selected, selectionStyle }, null, 2))
if (!ok) process.exitCode = 1
