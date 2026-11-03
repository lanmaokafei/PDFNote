import { chromium } from 'playwright-core'

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const browser = await chromium.launch({ executablePath: chrome, headless: true })
const page = await browser.newPage({ viewport: { width: 1000, height: 760 } })

await page.goto('http://127.0.0.1:1420/', { waitUntil: 'domcontentloaded' })
await page.waitForSelector('.app-shell')

const problems = []

// 在 Vite 开发服务器里直接加载真实模块，避免用副本验证。
const result = await page.evaluate(async () => {
  const { buildTitleLinkIndex, searchTitleLinks } = await import('/src/features/pdf/titleLink.ts')

  const cards = [
    { id: 'c1', question: '心肌梗死', link_aliases: 'MI;myocardial infarction' },
    { id: 'c2', question: 'STEMI' },
    { id: 'c3', question: '心肌梗死' },
    { id: 'c4', question: '这是一句很长很长的问题描述超过二十四个字所以不该成为关键词', link_aliases: 'RCA' },
  ]

  // 模拟一页 800x600 的文字行（归一化坐标）。
  const lines = [
    { text: '急性心肌梗死的诊断依据', x: 0.1, y: 0.1, width: 0.6, height: 0.03, confidence: 1 },
    { text: 'inferior STEMI case and MI', x: 0.1, y: 0.2, width: 0.6, height: 0.03, confidence: 1 },
    { text: 'XSTEMIX 不应命中', x: 0.1, y: 0.3, width: 0.4, height: 0.03, confidence: 1 },
  ]

  const index = buildTitleLinkIndex(cards)
  const hits = searchTitleLinks(index, lines)

  // 用真实 DOM 复刻高亮层，检查渲染位置与行框一致。
  const host = document.createElement('div')
  host.style.cssText = 'position:relative;width:800px;height:600px;background:#fff'
  document.body.appendChild(host)
  for (const hit of hits) {
    const button = document.createElement('button')
    button.className = 'pdf-titlelink'
    button.style.cssText = `position:absolute;left:${hit.bbox.x * 100}%;top:${hit.bbox.y * 100}%;width:${hit.bbox.width * 100}%;height:${hit.bbox.height * 100}%;border:0;background:rgba(58,124,165,.2)`
    button.textContent = hit.keyword
    host.appendChild(button)
  }
  const hostRect = host.getBoundingClientRect()
  const boxes = [...host.querySelectorAll('button')].map((element) => {
    const rect = element.getBoundingClientRect()
    return {
      keyword: element.textContent,
      left: (rect.left - hostRect.left) / hostRect.width,
      top: (rect.top - hostRect.top) / hostRect.height,
      width: rect.width / hostRect.width,
      height: rect.height / hostRect.height,
    }
  })

  return {
    keywords: hits.map((hit) => `${hit.keyword}@${hit.lineIndex}`),
    cardIds: hits.map((hit) => hit.cardIds.join('|')),
    boxes,
    entryCount: index.entries.length,
  }
})

// 断言 1：标题 + 别名 + 多卡聚合 + 拉丁词边界 + 长句不入字典。
if (!result.keywords.includes('心肌梗死@0')) problems.push('中文标题未命中首行')
if (result.keywords.some((key) => key.includes('XSTEMIX'))) problems.push('拉丁关键词缺少词边界')
// 5 条关键词：心肌梗死、MI、myocardial infarction、STEMI、RCA（长问题句不入字典）。
if (result.entryCount !== 5) problems.push(`字典条目数异常：${result.entryCount}`)
if (!result.cardIds.includes('c1|c3')) problems.push('同关键词未聚合多张卡片')

// 断言 2：高亮条渲染在对应行上（行 y=0.1/0.2，高 0.03），且宽度为正。
const chinese = result.boxes.find((box) => box.keyword === '心肌梗死')
if (!chinese) problems.push('中文命中未渲染高亮条')
else {
  if (Math.abs(chinese.top - 0.1) > 0.005) problems.push(`高亮条纵坐标偏差：${chinese.top}`)
  if (Math.abs(chinese.height - 0.03) > 0.005) problems.push(`高亮条高度异常：${chinese.height}`)
  if (chinese.width <= 0 || chinese.left <= 0.1) problems.push('高亮条未落在行内命中位置')
}
const latin = result.boxes.find((box) => box.keyword === 'MI')
if (!latin) problems.push('别名 MI 未命中')
else if (Math.abs(latin.top - 0.2) > 0.005) problems.push(`别名高亮条纵坐标偏差：${latin.top}`)

await browser.close()

console.log(JSON.stringify({ problems, result }, null, 2))
if (problems.length > 0) process.exitCode = 1
