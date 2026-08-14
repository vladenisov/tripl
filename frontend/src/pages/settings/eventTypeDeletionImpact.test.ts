import { describe, expect, it } from 'vitest'
import { describeEventTypeDeletionImpact } from './eventTypeDeletionImpact'

describe('describeEventTypeDeletionImpact', () => {
  it('says nothing else is affected when no events use the type', () => {
    const text = describeEventTypeDeletionImpact(0, 3)
    expect(text).toContain('3 field definitions')
    expect(text).toContain('No events use this type')
  })

  it('counts one event in the singular', () => {
    expect(describeEventTypeDeletionImpact(1, 1)).toContain('1 event,')
    expect(describeEventTypeDeletionImpact(1, 1)).toContain('1 field definition ')
  })

  it('names what goes with the events, not just the events', () => {
    // The old copy said only "field definitions and events will be removed",
    // which is the least of it: an event-composition metric loses its operand
    // and an alert rule filtered on those events can be switched off.
    const text = describeEventTypeDeletionImpact(12, 4)
    expect(text).toContain('12 events')
    expect(text).toContain('metrics')
    expect(text).toContain('alert rules')
  })

  it('counts archived events too, and says so', () => {
    // The count query passes every status on purpose; an unqualified events
    // list hides archived rows that the cascade still deletes.
    expect(describeEventTypeDeletionImpact(5, 1)).toContain('including archived ones')
  })

  it('never offers to archive the event type, because that does not exist', () => {
    // EventType carries no status column — only individual events can be
    // archived. Suggesting it would send someone hunting for a missing button.
    for (const events of [0, 1, 40]) {
      expect(describeEventTypeDeletionImpact(events, 2)).not.toContain('archive this event type')
      expect(describeEventTypeDeletionImpact(events, 2)).not.toContain('Archive the event type')
    }
  })
})
