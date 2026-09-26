import * as React from "react"
import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "placeholder:text-fg-tertiary flex min-h-16 w-full rounded-control border border-input bg-transparent px-2.5 py-1.5 text-body-sm shadow-xs outline-none transition-colors disabled:cursor-not-allowed disabled:border-dashed disabled:border-[var(--border-strong)] disabled:bg-transparent disabled:text-[var(--fg-subtle)]",
        "focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
        "aria-invalid:ring-destructive/20 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
