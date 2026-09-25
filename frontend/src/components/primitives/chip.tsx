import type { ComponentProps, ReactNode } from "react"
import { cn } from "@/lib/utils"
import { chipVariants, type ChipSize, type ChipTone, type ChipVariant } from "@/components/primitives/chip-variants"

export type { ChipSize, ChipTone, ChipVariant }

export type ChipProps = Omit<ComponentProps<"span">, "children"> & {
  children?: ReactNode
  tone?: ChipTone
  variant?: ChipVariant
  icon?: ReactNode
  size?: ChipSize
}

export function Chip({
  children,
  tone = "neutral",
  variant = "soft",
  icon,
  size = "sm",
  className,
  ...props
}: ChipProps) {
  return (
    <span
      data-slot="chip"
      data-tone={tone}
      className={cn(chipVariants({ tone, variant, size }), className)}
      {...props}
    >
      {icon}
      {children}
    </span>
  )
}
