import type { ChipTone } from '@/components/primitives/chip'
import type { DotTone } from '@/components/primitives/dot'

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

/**
 * Canonical status tone — matches the design mockup `STATUS_TONE`.
 * Drives Chip-based status rendering (events table, detail, edit) and the
 * status dot below. `ChipTone` and `DotTone` share the same tone vocabulary.
 */
export const EVENT_STATUS_TONE: Record<EventStatus, ChipTone> = {
  draft: 'neutral',
  in_review: 'warning',
  ready_for_dev: 'info',
  implemented: 'success',
  live: 'success',
  deprecated: 'warning',
  archived: 'neutral',
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

/**
 * Status indicator dot tone (used in EventRow). Derived from the canonical
 * tone scale so the dot and the status chip never drift apart.
 */
export const EVENT_STATUS_DOT_TONE: Record<EventStatus, DotTone> = EVENT_STATUS_TONE
