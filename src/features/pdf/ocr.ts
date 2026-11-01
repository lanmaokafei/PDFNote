import { createWorker, OEM, PSM, type Worker } from 'tesseract.js'
import { isTauriRuntime, recognizeNativeImage } from '../../services/pdfnote'

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
