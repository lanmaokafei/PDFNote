import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react'

/**
 * 「深墨连线」用的自定义边：圆角折线 + 目标端小圆点，不带箭头。
 * 参考 MarginNote 式画布——线是从父卡伸到子卡的分支，圆点标出接入位置。
 *
 * 只在小画布上启用（大画布退回默认 smoothstep）：每条边一个 React 组件，
 * 1483 张卡时是 1482 个组件，会明显拖慢缩放与拖拽。
 */
export function InkEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
}: EdgeProps) {
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 14,
  })
  const stroke = (style?.stroke as string | undefined) ?? '#2f3a33'
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      <circle cx={targetX} cy={targetY} r={2.8} fill={stroke} stroke="none" />
    </>
  )
}
