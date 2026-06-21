import { memo, useId, type CSSProperties } from "react"

export type SparklineVariant = "line" | "line-only" | "bar"

type SparklineProps = {
  data: number[]
  color?: string
  width?: number
  height?: number
  variant?: SparklineVariant
  anomalyIdx?: number | null
  className?: string
  style?: CSSProperties
}

function SparklineInner({
  data,
  color = "var(--accent)",
  width = 80,
  height = 22,
  variant = "line",
  anomalyIdx = null,
  className,
  style,
}: SparklineProps) {
  const gradId = useId()
  if (!data?.length) return null

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = Math.max(1, max - min)

  if (variant === "bar") {
    const barW = Math.max(1.5, width / data.length - 1)
    return (
      <svg width={width} height={height} aria-hidden="true" className={className} style={{ display: "block", ...style }}>
        {data.map((v, i) => {
          const h = Math.max(1, ((v - min) / range) * (height - 2))
          const isAnom = anomalyIdx === i
          return (
            <rect
              key={i}
              x={i * (width / data.length)}
              y={height - h}
              width={barW}
              height={h}
              fill={isAnom ? "var(--danger)" : color}
              opacity={isAnom ? 1 : 0.78}
              rx={1}
            />
          )
        })}
      </svg>
    )
  }

  const stepX = width / Math.max(1, data.length - 1)
  const points = data.map<[number, number]>((v, i) => [
    i * stepX,
    height - ((v - min) / range) * (height - 4) - 2,
  ])
  const path = points
    .map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`))
    .join(" ")
  const areaPath = `${path} L${width},${height} L0,${height} Z`

  return (
    <svg
      width={width}
      height={height}
      aria-hidden="true"
      className={className}
      style={{ display: "block", overflow: "visible", ...style }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.35" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {variant !== "line-only" && <path d={areaPath} fill={`url(#${gradId})`} />}
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="1.4"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {anomalyIdx != null && points[anomalyIdx] && (
        <circle
          cx={points[anomalyIdx][0]}
          cy={points[anomalyIdx][1]}
          r={2.5}
          fill="var(--danger)"
          stroke="var(--bg)"
          strokeWidth={1}
        />
      )}
    </svg>
  )
}

export const Sparkline = memo(SparklineInner)
