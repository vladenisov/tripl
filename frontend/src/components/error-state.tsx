import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn, getErrorMessage } from '@/lib/utils'

export function ErrorState({
  title,
  error,
  description,
  onRetry,
  retryLabel = 'Try again',
  compact = false,
  className,
  headingLevel = 2,
}: {
  title: string
  error?: unknown
  description?: string
  onRetry?: () => void
  retryLabel?: string
  compact?: boolean
  className?: string
  /**
   * Level of the title heading. 2 when the error replaces a page's content
   * under its h1; 3 inside a card that already has an h2 title, so the outline
   * does not flatten into two siblings (DS-16).
   */
  headingLevel?: 2 | 3 | 4
}) {
  const message = getErrorMessage(error)
  const Heading = `h${headingLevel}` as const

  return (
    <div
      role="alert"
      className={cn(
        'rounded-xl border border-destructive/35 bg-destructive/5 text-left',
        compact ? 'p-3' : 'p-5',
        className,
      )}
    >
      <div className={cn('flex gap-3', compact ? 'items-start' : 'items-center')}>
        <div className="mt-0.5 rounded-full bg-destructive/10 p-2 text-destructive">
          <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          {/* h2 for the same reason as EmptyState: an error surface replaces a
              page's content directly under its h1 (tripl-jfm3.69). */}
          <Heading className={cn('font-semibold text-foreground', compact ? 'text-sm' : 'text-base')}>{title}</Heading>
          {description && (
            <p className={cn('mt-1 text-muted-foreground', compact ? 'text-xs' : 'text-sm')}>
              {description}
            </p>
          )}
          <p className={cn('mt-1 break-words text-destructive', compact ? 'text-xs' : 'text-sm')}>
            {message}
          </p>
          {onRetry && (
            <Button type="button" variant="outline" size={compact ? 'sm' : 'default'} className="mt-3" onClick={onRetry}>
              {/* No margin or size here: Button already spaces and sizes its
                  icons, and `mr-2` on top doubled the gap (DS-47). */}
              <RefreshCw aria-hidden="true" />
              {retryLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
