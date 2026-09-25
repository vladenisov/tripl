import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type PageHeaderProps = {
  title: ReactNode
  /** Small uppercase section name above the title ("Observe", "Govern"). */
  eyebrow?: ReactNode
  /** A count shown after the title in the muted colour ("Events 17"). */
  count?: ReactNode
  /** Inline after the title and count: badges, identity chips. */
  titleAddon?: ReactNode
  description?: ReactNode
  /** Right-hand slot: buttons, a stat strip. Wraps under the title on phones. */
  actions?: ReactNode
  /** Above everything, e.g. a back link. */
  back?: ReactNode
  className?: string
}

/**
 * The one page header (DS-19 / LIVE-11): one type scale for the eyebrow, the
 * title and the description, so moving between pages, create forms and detail
 * views no longer jumps between seven title sizes and three description sizes.
 *
 * Scale: eyebrow 11px uppercase, title 21px semibold, description 12.5px, all
 * captions in `--fg-subtle`. The header carries no outer margin; the page's
 * own vertical rhythm spaces it.
 */
export function PageHeader({
  title,
  eyebrow,
  count,
  titleAddon,
  description,
  actions,
  back,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      {back && <div className="flex">{back}</div>}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-1 basis-60">
          {eyebrow && (
            <div
              className="text-[11px] font-semibold uppercase tracking-[0.08em]"
              style={{ color: 'var(--fg-subtle)' }}
            >
              {eyebrow}
            </div>
          )}
          <div className={cn('flex flex-wrap items-center gap-x-2.5 gap-y-1', eyebrow && 'mt-1')}>
            <h1 className="m-0 min-w-0 break-words text-title font-semibold tracking-[-0.01em]">
              {title}
              {count != null && (
                <>
                  {' '}
                  <span className="tnum font-normal" style={{ color: 'var(--fg-subtle)' }}>
                    {count}
                  </span>
                </>
              )}
            </h1>
            {titleAddon}
          </div>
          {description && (
            <div
              className="mt-1.5 max-w-[640px] text-body-sm leading-[1.5]"
              style={{ color: 'var(--fg-subtle)' }}
            >
              {description}
            </div>
          )}
        </div>
        {actions && <div className="flex max-w-full flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  )
}
