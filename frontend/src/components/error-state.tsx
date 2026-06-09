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
}: {
  title: string
  error?: unknown
  description?: string
  onRetry?: () => void
  retryLabel?: string
  compact?: boolean
  className?: string
}) {
  const message = getErrorMessage(error)

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
          <AlertTriangle className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className={cn('font-semibold text-foreground', compact ? 'text-sm' : 'text-base')}>{title}</h3>
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
              <RefreshCw className="mr-2 h-4 w-4" />
              {retryLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
