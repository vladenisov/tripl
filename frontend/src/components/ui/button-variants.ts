import { cva } from "class-variance-authority"

/*
 * Disabled is a neutral surface, not the live colours at half opacity. A faded
 * primary still read as the brand call to action, just washed out, and its
 * text fell below legible contrast (LIVE-32). Filled and outlined buttons turn
 * to the hover surface with --fg-muted text; the transparent ones (ghost,
 * danger, link) keep no fill and drop to --fg-faint. Both inks clear AA on
 * those surfaces (theme-contrast.test.ts).
 */
const DISABLED_FILLED =
  "disabled:border-[var(--border)] disabled:bg-[var(--surface-hover)] disabled:text-[var(--fg-muted)] disabled:shadow-none"
const DISABLED_BARE = "disabled:text-[var(--fg-faint)]"

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all cursor-pointer disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
  {
    variants: {
      variant: {
        default:
          `bg-primary text-primary-foreground shadow-xs hover:bg-primary/90 ${DISABLED_FILLED}`,
        destructive:
          `bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90 focus-visible:ring-destructive/20 ${DISABLED_FILLED}`,
        outline:
          `border border-input bg-background shadow-xs hover:bg-surface-hover hover:text-foreground active:bg-surface-active active:text-foreground ${DISABLED_FILLED}`,
        secondary:
          `bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80 ${DISABLED_FILLED}`,
        ghost:
          `hover:bg-surface-hover hover:text-foreground active:bg-surface-active active:text-foreground ${DISABLED_BARE}`,
        danger:
          `text-[var(--danger)] hover:bg-[var(--danger-soft)] hover:text-[var(--danger)] active:bg-[var(--danger-soft)] active:text-[var(--danger)] ${DISABLED_BARE}`,
        link: `text-primary underline-offset-4 hover:underline ${DISABLED_BARE}`,
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 rounded-md gap-1 px-2 has-[>svg]:px-1.5 text-[11px]",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5 text-xs",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)
