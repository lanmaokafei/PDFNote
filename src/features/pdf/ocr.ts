import { createWorker, OEM, PSM, type Worker } from 'tesseract.js'
import { isTauriRuntime, recognizeNativeImage } from '../../services/pdfnote'

/**
 * 判断 OCR 结果是否像数学公式。macOS Vision / Tesseract 这类纯文字引擎
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

let workerPromise: Promise<Worker> | null = null
let progressListener: ((progress: number, status: string) => void) | null = null

function normalizeChineseText(text: string): string {
  return text
    .replace(/\r/g, '')
    .replace(/([\u4e00-\u9fff])\s+(?=[\u4e00-\u9fff])/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

async function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker(['chi_sim', 'eng'], OEM.LSTM_ONLY, {
      workerPath: '/ocr/worker.min.js',
      corePath: '/ocr/core',
      langPath: '/ocr/lang',
      cacheMethod: 'none',
      workerBlobURL: false,
      gzip: true,
      logger: (message) => {
        progressListener?.(Math.round(message.progress * 100), message.status)
      },
    })
      .then(async (worker) => {
        await worker.setParameters({
          tessedit_pageseg_mode: PSM.AUTO,
          preserve_interword_spaces: '1',
          user_defined_dpi: '300',
        })
        return worker
      })
      .catch((error) => {
        workerPromise = null
        throw error
      })
  }
  return workerPromise
}

/**
 * Recognize a cropped region. The first call loads the bundled Chinese and
 * English language data locally; no network access is performed.
 */
export async function recognizeChinese(
  image: string,
  onProgress?: (progress: number, status: string) => void,
): Promise<string> {
  progressListener = onProgress ?? null
  try {
    const worker = await getWorker()
    const result = await worker.recognize(image)
    return normalizeChineseText(result.data.text ?? '')
  } finally {
    progressListener = null
  }
}

/**
 * Prefer the OS OCR engine (macOS Vision gives much better Chinese accuracy),
 * and fall back to the bundled Tesseract model on other platforms or on error.
 */
export async function recognizeText(
  image: string,
  onProgress?: (progress: number, status: string) => void,
): Promise<string> {
  if (isTauriRuntime()) {
    try {
      // An empty native result means the crop contains no text; do not spend
      // seconds loading the fallback model unless the native engine failed.
      return normalizeChineseText(await recognizeNativeImage(image))
    } catch {
      // Native OCR unavailable: continue with the offline Tesseract fallback.
    }
  }
  return recognizeChinese(image, onProgress)
}

export function isOcrReady(): boolean {
  return workerPromise !== null
}
