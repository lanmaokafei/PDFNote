import { looksLikeMathFormula } from './ocr'

export interface FormulaDecisionOptions {
  /** 选区拿到的文字（可能为空）。 */
  excerpt: string
  /** 文字是否来自 OCR（扫描页），OCR 对公式只能给出乱码。 */
  fromOcr: boolean
  /** 是否配置了可用的视觉模型。 */
  aiReady: boolean
  /** 是否有可用于识别的选区图像。 */
  hasImage: boolean
}

export interface FormulaDecision {
  /** 选区文字具备公式特征（不论来自文字层还是 OCR）。 */
  isFormula: boolean
  /** 公式来自 OCR，原文不可信，应丢弃后再建卡。 */
  discardExcerpt: boolean
  /** 是否应把选区图像交给视觉模型转 LaTeX。 */
  useVisionModel: boolean
}

/**
 * 公式处理决策。文字层公式与 OCR 公式都要考虑：
 * 之前只判断 OCR 来源，导致「框选文字层里的公式」永远只提示保留原图、不调用模型。
 */
export function decideFormulaRecognition(options: FormulaDecisionOptions): FormulaDecision {
  const isFormula = Boolean(options.excerpt.trim()) && looksLikeMathFormula(options.excerpt)
  return {
    isFormula,
    discardExcerpt: isFormula && options.fromOcr,
    useVisionModel: isFormula && options.aiReady && options.hasImage,
  }
}
