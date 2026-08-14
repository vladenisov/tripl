import { countOf } from '@/lib/plural'

/**
 * What deleting an event type actually destroys, said before it is destroyed.
 *
 * The confirm used to read "All associated field definitions and events of this
 * type will be removed" and stop there — true, and the least of it. Events go
 * through `events.event_type_id` ON DELETE CASCADE, and with them go the things
 * pointed AT those events: an event-composition metric's operand is unbound and
 * the metric can no longer produce a value, an alert rule's event filter loses
 * entries and the rule is switched off if that empties it, tuned detector
 * sensitivity is dropped, and event-scoped chart markers disappear.
 *
 * Counts only the two quantities honestly countable from data the page already
 * holds. The rest are named as KINDS on purpose: whether a filter empties is
 * decided by `plan_alert_filter_change`, and both `alert_rule_filters.values`
 * and `implementation_tickets.event_ids` are JSON matched in Python because the
 * containment operator is PostgreSQL-only. A faithful count would be a second
 * copy of the delete rule living in the frontend, and two copies of one rule is
 * the defect this whole area has been paying down.
 *
 * It does NOT offer to archive the event type: there is no such thing. `EventType`
 * carries no status column — only individual events can be archived — so
 * suggesting it would send someone hunting for a button that does not exist.
 *
 * Its own module, like `pages/alerting/deletionImpact.ts`, so it can be unit
 * tested without mounting the page.
 */
export function describeEventTypeDeletionImpact(events: number, fields: number): string {
  const removed = `Deletes ${countOf(fields, 'field definition', 'field definitions')}`

  if (events === 0) {
    return `${removed}. No events use this type, so nothing else is affected.`
  }

  return (
    `${removed} and ${countOf(events, 'event', 'events')}, including archived ones. `
    + 'Anything pointing at those events goes with them: metrics composed from them stop '
    + 'producing values, alert rules filtered on them lose those filters and are switched '
    + 'off if nothing is left to match, and their tuned sensitivity and chart markers are '
    + 'dropped. This cannot be undone — to keep the history, archive the events instead.'
  )
}
