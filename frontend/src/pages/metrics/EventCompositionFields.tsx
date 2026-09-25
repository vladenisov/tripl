import { useQuery } from '@tanstack/react-query'
import { eventTypesApi } from '@/api/eventTypes'
import { SCard, Select, TextInput } from '@/components/settings/kit'
import { eventTypesKey } from '@/lib/queryKeys'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { METRIC_COMPOSITIONS, type EventType, type MetricComposition } from '@/types'
import { EventRefPicker, type EventRef } from './EventRefPicker'
import { MetricField } from './MetricField'
import { errorAria, type FieldErrors } from './fieldErrors'
import type { MetricDraft } from './metricDraft'

// Human-readable labels for the composition select (raw option values are kept
// as-is on the wire).
const COMPOSITION_LABEL: Record<MetricComposition, string> = {
  single: 'Single',
  ratio: 'Ratio',
  per_distinct_user: 'Per distinct user',
}

const EMPTY_EVENT_TYPES: EventType[] = []

interface EventCompositionFieldsProps {
  slug: string
  draft: MetricDraft
  patch: (next: Partial<MetricDraft>) => void
  errors: FieldErrors
  disabled?: boolean
}

/** The event-composition card: composition, the event(s) it counts, user id column. */
export function EventCompositionFields({
  slug,
  draft,
  patch,
  errors,
  disabled,
}: EventCompositionFieldsProps) {
  // Event types are a short, unpaginated list; both pickers share this cache.
  const eventTypesQuery = useQuery({
    queryKey: eventTypesKey(slug, null),
    queryFn: () => eventTypesApi.list(slug),
    // Types are an optional second group in the pickers; a failure leaves the
    // events group working and is not worth a toast.
    meta: SILENT_ERROR_META,
  })
  const eventTypes = eventTypesQuery.data ?? EMPTY_EVENT_TYPES
  const isRatio = draft.composition === 'ratio'

  const numerator: EventRef = {
    eventId: draft.numeratorEventId,
    eventTypeId: draft.numeratorEventTypeId,
  }
  const denominator: EventRef = {
    eventId: draft.denominatorEventId,
    eventTypeId: draft.denominatorEventTypeId,
  }

  return (
    <SCard title="Event composition" description="Combine existing event series.">
      <MetricField label="Composition" htmlFor="metric-composition" required>
        <Select
          id="metric-composition"
          value={draft.composition}
          onChange={value => patch({ composition: value as MetricComposition })}
          options={METRIC_COMPOSITIONS.map(c => ({ value: c, label: COMPOSITION_LABEL[c] }))}
        />
      </MetricField>
      <MetricField
        label={isRatio ? 'Numerator event' : 'Event'}
        htmlFor="metric-numerator"
        required
        last={draft.composition === 'single'}
        hint="An event, or an event type to count every event of that type."
        error={errors['metric-numerator']}
      >
        <EventRefPicker
          slug={slug}
          id="metric-numerator"
          label={isRatio ? 'numerator events' : 'events'}
          value={numerator}
          onChange={next =>
            patch({ numeratorEventId: next.eventId, numeratorEventTypeId: next.eventTypeId })
          }
          eventTypes={eventTypes}
          disabled={disabled}
          {...errorAria(errors, 'metric-numerator')}
        />
      </MetricField>
      {isRatio && (
        <MetricField
          label="Denominator event"
          htmlFor="metric-denominator"
          required
          last
          hint="Required for a ratio metric."
          error={errors['metric-denominator']}
        >
          <EventRefPicker
            slug={slug}
            id="metric-denominator"
            label="denominator events"
            value={denominator}
            onChange={next =>
              patch({ denominatorEventId: next.eventId, denominatorEventTypeId: next.eventTypeId })
            }
            eventTypes={eventTypes}
            disabled={disabled}
            {...errorAria(errors, 'metric-denominator')}
          />
        </MetricField>
      )}
      {draft.composition === 'per_distinct_user' && (
        <MetricField
          label="User ID column"
          htmlFor="metric-user-id-column"
          last
          hint="Column counted for distinct users. Defaults to user_id."
        >
          <div className="max-w-[280px]">
            <TextInput
              id="metric-user-id-column"
              value={draft.userIdColumn}
              onChange={value => patch({ userIdColumn: value })}
              mono
              placeholder="user_id"
            />
          </div>
        </MetricField>
      )}
    </SCard>
  )
}
