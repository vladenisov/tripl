import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  BarChart3,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react'
import type { EventListItem } from '@/types'
import { EVENT_STATUS_LABELS, EVENT_STATUSES, type EventStatus } from '@/lib/eventStatus'
import { Button } from '@/components/ui/button'

export const EventRowActions = memo(function EventRowActions({
  event,
  slug,
  canMoveUp,
  canMoveDown,
  onEdit,
  onMoveUp,
  onMoveDown,
  onArchive,
  onRestore,
  onDelete,
  onSetStatus,
}: {
  event: EventListItem
  slug: string
  canMoveUp: boolean
  canMoveDown: boolean
  onEdit: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onArchive: () => void
  onRestore: () => void
  onDelete: () => void
  onSetStatus?: (status: EventStatus) => void
}) {
  const [isExpanded, setIsExpanded] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const closeTimerRef = useRef<number | null>(null)

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }, [])

  const openActions = useCallback(() => {
    clearCloseTimer()
    setIsExpanded(true)
  }, [clearCloseTimer])

  const scheduleClose = useCallback(() => {
    clearCloseTimer()
    closeTimerRef.current = window.setTimeout(() => {
      setIsExpanded(false)
      closeTimerRef.current = null
    }, 140)
  }, [clearCloseTimer])

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer])

  const isArchived = event.status === 'archived'

  return (
    <div
      ref={containerRef}
      className="relative flex items-center justify-end"
      onMouseLeave={scheduleClose}
      onBlur={event_ => {
        if (!containerRef.current?.contains(event_.relatedTarget as Node | null)) {
          scheduleClose()
        }
      }}
    >
      <div className="relative flex items-center justify-end">
        <div
          className={`absolute right-[calc(100%-1px)] top-1/2 z-50 flex -translate-y-1/2 items-center gap-1 rounded-l-lg border border-r-0 bg-background/95 p-1 shadow-lg backdrop-blur-sm transition-all duration-200 ease-out ${
            isExpanded
              ? 'pointer-events-auto translate-x-0 opacity-100'
              : 'pointer-events-none translate-x-2 opacity-0'
          }`}
          onMouseEnter={openActions}
        >
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Move event up"
            aria-label="Move event up"
            onClick={onMoveUp}
            disabled={!canMoveUp}
          >
            <ArrowUp className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Move event down"
            aria-label="Move event down"
            onClick={onMoveDown}
            disabled={!canMoveDown}
          >
            <ArrowDown className="h-3.5 w-3.5" />
          </Button>
          {onSetStatus && (
            <select
              value={event.status}
              onChange={e => onSetStatus(e.target.value as EventStatus)}
              className="h-7 rounded border border-input bg-background px-1.5 text-[11px] focus:outline-none"
              title="Set status"
              aria-label="Set event status"
            >
              {EVENT_STATUSES.map(s => (
                <option key={s} value={s}>{EVENT_STATUS_LABELS[s]}</option>
              ))}
            </select>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="View metrics"
            aria-label="View metrics"
            asChild
          >
            <Link to={`/p/${slug}/monitoring/event/${event.id}`}>
              <BarChart3 className="h-3.5 w-3.5" />
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            title={isArchived ? 'Restore (set to Draft)' : 'Archive'}
            aria-label={isArchived ? 'Restore event' : 'Archive event'}
            onClick={isArchived ? onRestore : onArchive}
          >
            {isArchived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground hover:text-destructive"
            title="Delete event"
            aria-label="Delete event"
            onClick={onDelete}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
        <div className={`relative z-10 flex items-center gap-1 rounded-lg border bg-background/95 p-1 backdrop-blur-sm transition-shadow ${isExpanded ? 'shadow-lg' : 'shadow-sm'}`}>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Edit event"
            aria-label="Edit event"
            onClick={onEdit}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="More actions"
            aria-label="More actions"
            onMouseEnter={openActions}
            onFocus={openActions}
            onClick={() => {
              if (isExpanded) {
                scheduleClose()
              } else {
                openActions()
              }
            }}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
})
