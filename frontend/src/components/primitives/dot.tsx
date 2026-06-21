import { cn } from "@/lib/utils"

export type DotTone = "neutral" | "success" | "warning" | "danger" | "info" | "accent"

const COLORS: Record<DotTone, string> = {
  neutral: "var(--fg-faint)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--danger)",
  info: "var(--info)",
  accent: "var(--accent)",
}

type DotProps = {
  tone?: DotTone
  pulse?: boolean
  size?: number
  className?: string
}

export function Dot({ tone = "neutral", pulse = false, size = 7, className }: DotProps) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block rounded-full shrink-0", pulse && "pulse-dot", className)}
      style={{ width: size, height: size, background: COLORS[tone] }}
    />
  )
}
