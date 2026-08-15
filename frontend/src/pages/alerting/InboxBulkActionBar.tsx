import { useState } from 'react'
import { X } from 'lucide-react'

import { MAX_BULK_INBOX_ACTION_GROUPS } from '@/api/alerting'
import { Button } from '@/components/ui/button'
import {
  INBOX_MUTE_CHOICES,
  muteChoiceName,
  muteChoiceUntilIso,
  muteName,
} from '@/lib/mutePresets'
import { countOf } from '@/lib/plural'
import type { AlertInboxBulkAction } from '@/types'

/**
 * One triage decision raised by the bar, before it knows which incidents it
 * applies to.
 *
 * The bar deliberately does NOT hold the ids. Selection lives on
 * `ProjectAlertingTab` beside the query whose rows it indexes into, so the
 * page is the only thing that can prune a selection when a filter change or a
 * refetch drops rows out from under it. The bar knows a COUNT — which is all
 * its words need — and the page attaches the ids at click time (tripl-gpfr).
 *
 * `mutedUntil` has the same three non-interchangeable states as the
 * single-incident {@link InboxActionVariables}, for the same reason
 * (tripl-a50u): `undefined` = no mute value at all, a string = mute until that
 * instant, `null` = mute with NO end. Nothing downstream may branch on
 * truthiness — a `&& mutedUntil` drops the key from the request body for
 * exactly the most far-reaching choice on the bar.
 */
export interface InboxBulkActionRequest {
  action: AlertInboxBulkAction
  mutedUntil?: string | null
}

/**
 * How the bar names what it is about to act on: "4 selected incidents".
 *
 * Every control on the bar is announced with this as its target, so a screen
 * reader user hears the size of the blast radius on the button itself and not
 * only in the count at the far left of a fixed bar they may never have visited.
 * It is also what makes the shared mute name builder work here: `muteName` and
 * `muteChoiceName` take a plain string target precisely so they can be given
 * something that is not a scope.
 */
function selectionTarget(count: number): string {
  return countOf(count, 'selected incident', 'selected incidents')
}

/**
 * What to do about a selection the server will not accept, said BEFORE acting.
 *
 * The batch route caps the id list at {@link MAX_BULK_INBOX_ACTION_GROUPS} and
 * refuses a longer one with a 422 (tripl-gpfr). Nothing on the page used to
 * bound the selection, and the inbox is an ACCUMULATING infinite list at 50 rows
 * per page — so a fifth "Load more" puts 250 tickable rows on screen and the
 * operator learns about the cap by watching a decision they had already
 * committed to fail with a validation error about a list length.
 *
 * The sentence names the limit and the arithmetic, because "too many" leaves the
 * reader counting ticks: over the cap the only thing they can do is untick a
 * specific number of rows, so the message is that number. It is a bar-level
 * message rather than a per-button tooltip for the reason the whole bar exists —
 * one decision, one place to read about it — and the actions go disabled beside
 * it rather than staying clickable, since a button that posts a request known in
 * advance to be refused is the affordance this replaces.
 */
function overCapNotice(overBy: number): string {
  return (
    `Over the ${MAX_BULK_INBOX_ACTION_GROUPS}-incident limit — untick `
    + `${countOf(overBy, 'incident', 'incidents')} to act on the rest.`
  )
}

interface InboxBulkActionBarProps {
  selectedCount: number
  /** One request is in flight for the whole batch — there is no per-row state. */
  isPending: boolean
  onAction: (request: InboxBulkActionRequest) => void
  onClear: () => void
}

/**
 * The floating bar that acts on every selected incident in one request
 * (tripl-gpfr).
 *
 * Chrome, position and the "<N> selected" phrasing are copied from
 * `pages/events/BulkActionBar` on purpose: this is the second bulk surface in
 * the app, and an operator who has met the first one should not have to learn
 * that this one is the same idea. What differs is only the verbs.
 *
 * WHAT IS NOT HERE, and must not be added:
 *
 *  - "False positive". It is the only inbox action refused in bulk, and the
 *    refusal is not a limitation to work around: direction is part of the
 *    correlation key, so a single scope's spike and drop are two incidents in
 *    this list, and marking both would ratchet that one scope's detection
 *    thresholds twice for one human decision with nothing in the record saying
 *    it was one click. The type of {@link InboxBulkActionRequest.action} makes
 *    the button unspellable rather than merely absent, so this comment is not
 *    the only guard. It stays available on each incident's own action row.
 *  - "Select all N matching". The events bar offers it because a status change
 *    there is cheap and reversible; here the cheapest thing on the bar silences
 *    alerting for a whole scope, and the batch is capped at
 *    {@link MAX_BULK_INBOX_ACTION_GROUPS} anyway. Selecting is deliberately
 *    per-incident, i.e. deliberately deliberate.
 *
 * Renders nothing at zero selection — a fixed bar over an untouched list is
 * chrome charging rent on the queue it sits on top of.
 */
export function InboxBulkActionBar({
  selectedCount,
  isPending,
  onAction,
  onClear,
}: InboxBulkActionBarProps) {
  // Same disclosure shape as the incident card's mute: the durations are
  // revealed, never applied by the control that reveals them. A bar button
  // labelled just "Mute" that silently posts seven days is the defect
  // `mutePresets` was extracted to end (tripl-oxkt.7), and it would be worse
  // here, where one click covers a screenful of incidents.
  const [muteOpen, setMuteOpen] = useState(false)

  if (selectedCount === 0) {
    // The bar hides itself here but stays MOUNTED, so an expanded duration row
    // survives the selection being cleared and comes back already open on the
    // next one — offering "Until I unmute", the furthest-reaching control on the
    // page, to someone who has just ticked one new incident and never asked for
    // it. Adjusting state during render is React's documented way to follow a
    // prop, and the guard makes it converge in one extra render (tripl-gpfr).
    if (muteOpen) setMuteOpen(false)
    return null
  }

  const target = selectionTarget(selectedCount)
  // How far past what the server will accept this selection is (tripl-gpfr).
  // Every ACTION is switched off above the cap — see `overCapNotice` — while
  // "Clear selection" and the individual checkboxes stay live, because those are
  // the two ways back under it.
  const overCapBy = selectedCount - MAX_BULK_INBOX_ACTION_GROUPS
  const isOverCap = overCapBy > 0
  const actionsDisabled = isPending || isOverCap
  const run = (request: InboxBulkActionRequest) => {
    setMuteOpen(false)
    onAction(request)
  }

  return (
    <div
      className="fixed bottom-[18px] left-1/2 z-30 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-wrap items-center gap-2.5 rounded-[10px] border py-1.5 pl-3.5 pr-2"
      style={{
        background: 'var(--bg-elevated)',
        borderColor: 'var(--border-strong)',
        boxShadow: 'var(--shadow-lg)',
      }}
      // Named as a group so the bar is findable as one thing, and so its
      // presence is assertable without depending on which verbs it currently
      // offers.
      role="group"
      aria-label="Bulk incident actions"
    >
      <span className="text-[12px]" style={{ color: 'var(--fg-muted)' }}>
        <span className="mono font-semibold" style={{ color: 'var(--fg)' }}>{selectedCount}</span> selected
      </span>
      {isOverCap && (
        // `role="status"`, so it is ANNOUNCED and not merely visible: the four
        // buttons beside it go disabled in the same render, and a row of
        // controls that stops working without saying why is the failure this
        // line exists to prevent. Warning rather than danger — nothing has gone
        // wrong, the operator simply has to untick some rows.
        <span role="status" className="text-[11px]" style={{ color: 'var(--warning)' }}>
          {overCapNotice(overCapBy)}
        </span>
      )}
      <div className="h-5 w-px" style={{ background: 'var(--border)' }} />
      {/* No fixed-slot rule here, unlike the incident card (tripl-oxkt.8). That
          rule exists because the card's buttons line up in a COLUMN across
          rows, so a slot that appears on one row and not the next moves the
          destructive action under a cursor aimed at a snooze. This bar is one
          row that never moves, and a selection spanning several statuses has no
          single status to disable against — every action here is meaningful on
          a mixed selection, and the server applies each one idempotently. */}
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-[11px]"
        aria-label={`Acknowledge ${target}`}
        title="Stops re-delivery on each one until its scope goes quiet, then each reopens by itself. Reversible."
        disabled={actionsDisabled}
        onClick={() => run({ action: 'acknowledge' })}
      >
        Acknowledge
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-[11px]"
        aria-label={`Resolve ${target}`}
        title="Same suppression as Acknowledge, different bucket in the filter. Each reopens by itself once its scope goes quiet. Reversible."
        disabled={actionsDisabled}
        onClick={() => run({ action: 'resolve' })}
      >
        Resolve
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-[11px]"
        aria-expanded={muteOpen}
        // The shared "Mute <target>" sentence, given a count instead of a scope.
        // The incident card's other branch ("Change mute on …") has no meaning
        // here: a selection can hold muted and unmuted incidents at once, and
        // this control does the same thing to both.
        aria-label={muteName(target)}
        title="Silences each selected incident on its own exact scan + rule + scope + signal kind + direction — for a preset duration, or until you unmute it. Asks first."
        disabled={actionsDisabled}
        onClick={() => setMuteOpen(current => !current)}
      >
        Mute
      </Button>
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-[11px]"
        // One word for one slot, and it is the surface's own word, not mute
        // vocabulary: `reopen` lifts acknowledge, resolve and false-positive as
        // well as a mute. The card can say "Unmute" because it knows the one
        // status it is looking at; a mixed selection does not, so the honest
        // name is the one that covers every case (tripl-oxkt.3).
        aria-label={`Reopen ${target}`}
        title="Puts each one back in the open queue. Alerts resume, and any mute on them is lifted."
        disabled={actionsDisabled}
        onClick={() => run({ action: 'reopen' })}
      >
        Reopen
      </Button>
      {muteOpen && (
        <div className="flex flex-wrap items-center gap-1 text-[10px]" style={{ color: 'var(--fg-muted)' }}>
          <span>Mute for</span>
          {/* INBOX_MUTE_CHOICES, not MUTE_PRESETS, and not re-typed literals.
              The shared module documents the scope rule: the open-ended choice
              belongs to INCIDENTS, because a NULL `muted_until` on an incident
              is a mute that never lapses, while the same NULL on an alert RULE
              means not muted at all (`is_rule_muted`). These are incidents, so
              the open-ended choice IS offered here — and the sentence each
              button is announced by comes from the same module, so this fourth
              mute surface cannot drift from the other three by rewording an
              `aria-label` in place (tripl-a50u, tripl-yapg). */}
          {INBOX_MUTE_CHOICES.map(choice => (
            <Button
              key={choice.label}
              size="sm"
              variant="outline"
              className="h-6 px-2 text-[10px]"
              // Visible face and accessible name differ on the open-ended
              // button by design — "Mute 4 selected incidents for Until I
              // unmute" is not English. See `muteChoiceName` for the reasoning
              // and for the one accepted WCAG 2.5.3 deviation it carries.
              aria-label={muteChoiceName(target, choice)}
              disabled={actionsDisabled}
              onClick={() => run({ action: 'mute', mutedUntil: muteChoiceUntilIso(choice) })}
            >
              {choice.label}
            </Button>
          ))}
        </div>
      )}
      <div className="h-5 w-px" style={{ background: 'var(--border)' }} />
      <button
        type="button"
        onClick={onClear}
        className="flex h-6 w-6 items-center justify-center rounded text-[var(--fg-subtle)] hover:text-[var(--fg)]"
        aria-label="Clear selection"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
