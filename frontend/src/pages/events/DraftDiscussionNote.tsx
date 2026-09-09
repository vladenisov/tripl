import { MessageCircle } from 'lucide-react'
import { useId } from 'react'

export interface DraftDiscussionNoteProps {
  value: string
  onChange: (next: string) => void
  /** Why the note that was drafted did not get posted, when a previous attempt
   *  failed. Rendered as an alert above the box rather than swallowed. */
  error?: string | null
}

/**
 * The Discussion composer on the CREATE form.
 *
 * A comment needs an event to hang on, so the thread itself cannot exist yet —
 * but the question does. "Should this fire on cancel too?" occurs while the
 * event is being authored, and by the time it exists its author has navigated
 * away (tripl-htfn.1).
 *
 * It is not Description and not Title, and the copy says so: everything else on
 * this page travels with the event into the spec the implementer reads, while
 * this is the one box that does not.
 */
export function DraftDiscussionNote({ value, onChange, error }: DraftDiscussionNoteProps) {
  const id = useId()
  return (
    <div className="flex flex-col gap-2 rounded-md border bg-card p-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <MessageCircle className="h-4 w-4 text-muted-foreground" />
        Discussion
      </div>
      <label htmlFor={id} className="text-xs text-muted-foreground">
        A question or note about this event, kept out of the spec. It is posted as the first comment
        the moment the event is created.
      </label>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <textarea
        id={id}
        value={value}
        onChange={event => onChange(event.target.value)}
        placeholder="Should this fire on cancel too?"
        className="min-h-[60px] w-full rounded-md border bg-background px-2 py-1 text-sm"
      />
    </div>
  )
}
