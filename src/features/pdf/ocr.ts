import { isTauriRuntime, recognizeNativeImage } from '../../services/pdfnote'

/**
 * 判断 OCR 结果是否像数学公式。Apple Vision 是纯文字 OCR 引擎，
 * 无法识别公式结构，输出通常是"字母数字混杂 + 数学符号 + 中文乱码"，
 * 直接作为摘录会污染卡片。命中强特征即可判定为疑似公式。
 */
export function looksLikeMathFormula(text: string): boolean {
  const compact = text.replace(/\s+/g, '')
  if (compact.length < 3) return false

  // 强特征：求和/积分/根号/分数等版式符号，OCR 引擎几乎只会出现在公式里。
  const strong = /[∑∫∬∭∮√∂∇∞≈≠≤≥±×÷∈⊕⊗∴∵∑]|Σ|Π|√/u
  if (strong.test(compact)) return true

  let score = 0
  // log / ln / sin / cos / tan / lim / exp（含 OCR 把 l 误识为 1/I 的情况）。
  if (/(?:1|I|l|L)og|1n|ln|sin|cos|tan|lim|exp/i.test(compact)) score += 2
  // 单字母变量 + 括号：P(x)、f(x_i)、Q(X) 等。
  if (/[A-Za-z]\([^)]{1,12}\)/.test(compact) && /[A-Za-z]/.test(compact)) score += 2
  // 变量赋值形：H =、y=、E(X)=。
  if (/^[A-Za-z]{1,3}=.+/i.test(compact) || /[A-Za-z]=-\S/.test(compact)) score += 1
  // 下标/上标残留：x_i、x1、a²、10⁻³。
  if (/[A-Za-z][₀-₉]/.test(compact) || /[⁰-⁹°²³]/.test(compact)) score += 1
  // 高密度运算符与括号混杂（排除普通标点）。
  const mathChars = compact.match(/[=()+\-*/^_[\]{}|,.;:0-9]/g)?.length ?? 0
  if (mathChars / compact.length > 0.45) score += 1

  return score >= 3
}

function normalizeChineseText(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 用 Apple Vision（macOS 原生）识别框选区域。
 *
 * PDFNote 仅面向 macOS 分发，不再打包 Tesseract 离线模型。原生引擎失败时
 * 直接抛错，由调用方保留选区图像并提示用户，而不是静默降级到准确率更低的
 * 引擎或把乱码写进卡片。
 */
export async function recognizeText(image: string): Promise<string> {
  if (!isTauriRuntime()) {
    throw new Error('OCR 仅可在 PDFNote 桌面应用（macOS）中使用')
  }
  return normalizeChineseText(await recognizeNativeImage(image))
}
