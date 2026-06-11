export type EventStatus =
  | 'draft'
  | 'in_review'
  | 'ready_for_dev'
  | 'implemented'
  | 'live'
  | 'deprecated'
  | 'archived'

export const EVENT_STATUSES: EventStatus[] = [
  'draft',
  'in_review',
  'ready_for_dev',
  'implemented',
  'live',
  'deprecated',
  'archived',
]

export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  draft: 'Draft',
  in_review: 'In Review',
  ready_for_dev: 'Ready for Dev',
  implemented: 'Implemented',
  live: 'Live',
  deprecated: 'Deprecated',
  archived: 'Archived',
}

/** Badge variant from badge.tsx variants */
export type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | 'success' | 'warning' | 'info'

export const EVENT_STATUS_BADGE_VARIANT: Record<EventStatus, BadgeVariant> = {
  draft: 'secondary',
  in_review: 'warning',
  ready_for_dev: 'info',
  implemented: 'success',
  live: 'success',
  deprecated: 'warning',
  archived: 'secondary',
}

/** Dot tone used in EventRow for status indicator */
export type DotTone = 'success' | 'warning' | 'neutral'

export const EVENT_STATUS_DOT_TONE: Record<EventStatus, DotTone> = {
  draft: 'neutral',
  in_review: 'warning',
  ready_for_dev: 'neutral',
  implemented: 'success',
  live: 'success',
  deprecated: 'warning',
  archived: 'neutral',
}
