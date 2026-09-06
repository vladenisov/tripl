import { useState } from "react"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"

import {
  CADENCE_OPTIONS,
  WEEKDAY_LABELS,
  cadenceToCron,
  cronToCadence,
  describeCron,
  formatInProjectZone,
  validateCadence,
  type CadenceDraft,
  type CadenceMode,
} from "./deliverySchedule"

interface DeliveryScheduleFieldProps {
  /** The cron expression currently on the form, '' meaning immediate. */
  value: string
  onChange: (cron: string) => void
  /** The project's IANA zone, so the copy can say which clock these times are on. */
  projectTimezone: string
  /** When the next digest is due, from the server. Null while immediate. */
  nextDigestAt?: string | null
  disabled?: boolean
}

/**
 * Pick how often a destination delivers.
 *
 * The presets and the cron box edit the same underlying string — the form
 * holds a cron expression and nothing else — so switching to Custom shows what
 * the preset was actually asking for rather than starting from blank.
 */
export function DeliveryScheduleField({
  value,
  onChange,
  projectTimezone,
  nextDigestAt,
  disabled = false,
}: DeliveryScheduleFieldProps) {
  // The draft is held locally rather than derived from `value` on every
  // render. Deriving it looks tidier and is wrong: a half-typed time is not a
  // valid cron, `cadenceToCron` returns null for it, and the field would
  // silently reset the destination to "immediate" while the operator was still
  // typing — turning a typo into a paging change nobody asked for.
  const [draft, setDraft] = useState<CadenceDraft>(() => cronToCadence(value))

  // Re-seed when `value` changes from OUTSIDE (opening a different
  // destination), but never while the local draft still means the same thing —
  // that would clobber whatever is being typed. Adjusted during render rather
  // than in an effect, which is React's documented shape for "reset state when
  // a prop changes" and the shape ProjectGeneralSection already uses to
  // hydrate its form from a query.
  const [seededFrom, setSeededFrom] = useState(value)
  if (seededFrom !== value) {
    setSeededFrom(value)
    if ((cadenceToCron(draft) ?? "") !== value) setDraft(cronToCadence(value))
  }

  const error = validateCadence(draft)

  const update = (next: CadenceDraft) => {
    setDraft(next)
    // Only a valid cadence is published upwards. An invalid one keeps the last
    // good expression on the form and shows the error below, so the schedule
    // never changes to something the operator did not choose.
    if (validateCadence(next) === null) onChange(cadenceToCron(next) ?? "")
  }

  return (
    <div className="grid gap-2">
      <Label htmlFor="destination-cadence">Delivery schedule</Label>
      <Select
        value={draft.mode}
        onValueChange={mode => {
          const next = { ...draft, mode: mode as CadenceMode }
          // Seed Custom from whatever the preset currently means, so the box is
          // never blank and an accidental switch loses nothing.
          if (mode === "custom") next.cron = cadenceToCron(draft) ?? ""
          update(next)
        }}
        disabled={disabled}
      >
        <SelectTrigger id="destination-cadence">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {CADENCE_OPTIONS.map(option => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {(draft.mode === "daily" || draft.mode === "weekly") && (
        <div className="grid gap-2 sm:grid-cols-2">
          {draft.mode === "weekly" && (
            <Select
              value={String(draft.weekday)}
              onValueChange={weekday => update({ ...draft, weekday: Number(weekday) })}
              disabled={disabled}
            >
              <SelectTrigger id="destination-cadence-weekday" aria-label="Day of week">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WEEKDAY_LABELS.map((label, index) => (
                  <SelectItem key={label} value={String(index)}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Input
            id="destination-cadence-time"
            aria-label="Time of day"
            placeholder="09:00"
            value={draft.time}
            onChange={event => update({ ...draft, time: event.target.value })}
            disabled={disabled}
          />
        </div>
      )}

      {draft.mode === "times_of_day" && (
        <Input
          id="destination-cadence-times"
          aria-label="Times of day"
          placeholder="09:00, 18:00"
          value={draft.times}
          onChange={event => update({ ...draft, times: event.target.value })}
          disabled={disabled}
        />
      )}

      {draft.mode === "custom" && (
        <Input
          id="destination-cadence-cron"
          aria-label="Cron expression"
          placeholder="0 9,18 * * 1-5"
          value={draft.cron}
          onChange={event => update({ ...draft, cron: event.target.value })}
          disabled={disabled}
        />
      )}

      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        <p className="text-xs text-muted-foreground">
          {draft.mode === "immediate"
            ? "Alerts are sent as soon as a collection finds something."
            : `${describeCron(value)} (${projectTimezone}). Everything found in between is collected into one message.`}
          {nextDigestAt && draft.mode !== "immediate"
            ? ` Next: ${formatInProjectZone(nextDigestAt, projectTimezone)}.`
            : ""}
        </p>
      )}
    </div>
  )
}
