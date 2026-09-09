import { ArrowUpRight, Ticket } from 'lucide-react'
import { Chip } from '@/components/primitives/chip'
import type { ImplementationTicket } from '@/types/tracker'

/** One tracker ticket, as a row.
 *
 * Shared because the same row answers two questions off the same table: which
 * tickets a branch opened, and which tickets ever named an event —
 * `uq_implementation_ticket_branch` is one ticket per branch, and `event_ids`
 * lists what that branch touched, so an event carried by three merged branches
 * is named by three of these (tripl-h2sx.32).
 */

export function ImplementationTicketRow({ ticket }: { ticket: ImplementationTicket }) {
  // Sync flips the ticket closed once the tracker reports the issue done, which
  // is also what promotes the covered events to `implemented`.
  const done = ticket.status === 'closed'
  // The tracker can answer without an issue key (and then without a URL); show
  // what we have as plain text rather than a link that goes nowhere.
  const label = ticket.external_key || 'Ticket'

  return (
    <div
      className="flex items-center gap-2 border-t px-4 py-2.5 first:border-t-0"
      style={{ borderColor: 'var(--border-subtle)' }}
    >
      <Ticket
        className="size-3.5 shrink-0"
        style={{ color: 'var(--fg-subtle)' }}
        aria-hidden="true"
      />
      {ticket.external_url ? (
        <a
          href={ticket.external_url}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-[12.5px] font-medium underline"
          style={{ color: 'var(--accent)' }}
        >
          {label}
          <ArrowUpRight className="ml-0.5 inline size-3" aria-hidden="true" />
        </a>
      ) : (
        <span className="shrink-0 text-[12.5px] font-medium" style={{ color: 'var(--fg)' }}>
          {label}
        </span>
      )}
      <span className="truncate text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
        {ticket.summary}
      </span>
      <div className="flex-1" />
      <Chip tone={done ? 'success' : 'neutral'} size="xs">
        {done ? 'Done' : 'Open'}
      </Chip>
    </div>
  )
}
