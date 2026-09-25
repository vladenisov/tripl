import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * A caption + control row that stacks on phones.
 *
 * Below `sm` the caption sits above the control at full width; from `sm` up it
 * becomes a fixed-width column beside it. Every authoring form used to hard-code
 * the side-by-side layout (a 200px event caption, a 232px scan caption, a 180px
 * event-type caption), which left a 375px screen 40-60px for the control: the
 * Name box showed two letters and a select only its chevron. The settings kit's
 * `Field` stacked correctly; this is that layout, shared.
 *
 * Presentation only: the caller renders the caption (a `<label>`, or a `<span>`
 * naming a group) and owns padding, borders and ARIA on the row.
 */
export function FormRow({
  caption,
  children,
  labelWidth = 232,
  captionClassName,
  className,
  style,
  ...rest
}: {
  caption: ReactNode
  children: ReactNode
  /** The caption column's width from `sm` up, in px. */
  labelWidth?: number
  /** Extra classes on the caption column (e.g. top padding to align with a 34px control). */
  captionClassName?: string
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot="form-row"
      {...rest}
      className={cn('flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-6', className)}
      style={{ ...style, '--form-row-label': `${labelWidth}px` } as CSSProperties}
    >
      <div
        data-slot="form-row-caption"
        className={cn('w-full sm:w-(--form-row-label) sm:shrink-0', captionClassName)}
      >
        {caption}
      </div>
      <div data-slot="form-row-control" className="min-w-0 flex-1">
        {children}
      </div>
    </div>
  )
}
