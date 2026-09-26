import * as React from "react"
import { cn } from "@/lib/utils"

/**
 * One grey placeholder bar. On the surface ladder (`surface-hover`, one step
 * above a card) rather than `bg-muted`, so a bar reads on white cards and on
 * the grey canvas alike, and the pulse stops for reduced motion. Page- and
 * section-shaped arrangements live in components/states/skeletons.tsx.
 */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      aria-hidden="true"
      className={cn(
        "bg-surface-hover animate-pulse rounded-sm motion-reduce:animate-none",
        className,
      )}
      {...props}
    />
  )
}

export { Skeleton }
