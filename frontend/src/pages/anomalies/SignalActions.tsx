import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  BellOff,
  BellRing,
  CalendarPlus,
  Check,
  CircleCheck,
  ExternalLink,
  MoreHorizontal,
  Undo2,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { getAlertingPath } from '@/lib/navigation'
import { useCanWriteProject } from '@/lib/permissions'
import { signalScopeLabel, unnamedScopeLabel } from '@/lib/signalScope'
import type { MonitoringSignal } from '@/types'
import { ExpectedSignalDialog } from './ExpectedSignalDialog'
import { MUTE_OPTIONS, canTriageSignal, useSignalTriage } from './signalTriage'

const ICON_CLASS = 'h-3.5 w-3.5 shrink-0'
const ICON_STYLE = { color: 'var(--fg-subtle)' }

/**
 * The row's action menu (MO-4 / JR-5): open the detail, jump to the incident or
 * the alerts, annotate the bucket — and, for a signal no rule routed to an
 * incident, triage it here: acknowledge, mute the scope, or mark it as expected,
 * each with its Undo. A routed signal keeps "Open incident" instead; its triage
 * is the inbox's. Mute durations are a labelled group rather than a submenu:
 * the menu primitive has none, on purpose (DS-36).
 */
export function SignalActions({
  slug,
  signal,
  href,
}: {
  slug: string
  signal: MonitoringSignal
  href: string | undefined
}) {
  const navigate = useNavigate()
  const canWrite = useCanWriteProject()
  const triage = useSignalTriage(slug)
  const [expectedOpen, setExpectedOpen] = useState(false)
  const triageable = canWrite && canTriageSignal(signal)
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Signal actions" className="text-fg-muted">
            <MoreHorizontal aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} className="w-52">
          {href && (
            <DropdownMenuItem asChild className="text-body-sm">
              <Link to={href}>
                <ExternalLink className={ICON_CLASS} style={ICON_STYLE} /> Open detail
              </Link>
            </DropdownMenuItem>
          )}
          <DropdownMenuItem asChild className="text-body-sm">
            <Link to={getAlertingPath(slug, { incidentId: signal.incident_id })}>
              <BellRing className={ICON_CLASS} style={ICON_STYLE} />{' '}
              {signal.incident_id ? 'Open incident' : 'View alerts'}
            </Link>
          </DropdownMenuItem>
          {/* The detail page's banner Annotate, from here: its Volume tab with
              the form prefilled on this bucket (JR-5). */}
          {href && canWrite && (
            <DropdownMenuItem
              className="text-body-sm"
              onSelect={() => navigate(href, { state: { annotateBucket: signal.bucket } })}
            >
              <CalendarPlus className={ICON_CLASS} style={ICON_STYLE} /> Annotate
            </DropdownMenuItem>
          )}
          {triageable && (
            <>
              <DropdownMenuSeparator />
              {signal.acknowledged_at ? (
                <DropdownMenuItem
                  className="text-body-sm"
                  disabled={triage.isPending}
                  onSelect={() => triage.run(signal, { kind: 'unacknowledge' })}
                >
                  <Undo2 className={ICON_CLASS} style={ICON_STYLE} /> Undo acknowledge
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  className="text-body-sm"
                  disabled={triage.isPending}
                  onSelect={() => triage.run(signal, { kind: 'acknowledge' })}
                >
                  <Check className={ICON_CLASS} style={ICON_STYLE} /> Acknowledge
                </DropdownMenuItem>
              )}
              {signal.expected ? (
                <DropdownMenuItem
                  className="text-body-sm"
                  disabled={triage.isPending}
                  onSelect={() => triage.run(signal, { kind: 'unexpected' })}
                >
                  <Undo2 className={ICON_CLASS} style={ICON_STYLE} /> Undo expected
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem
                  className="text-body-sm"
                  disabled={triage.isPending}
                  onSelect={() => setExpectedOpen(true)}
                >
                  <CircleCheck className={ICON_CLASS} style={ICON_STYLE} /> Mark as expected…
                </DropdownMenuItem>
              )}
              {signal.muted ? (
                <DropdownMenuItem
                  className="text-body-sm"
                  disabled={triage.isPending}
                  onSelect={() => triage.run(signal, { kind: 'unmute' })}
                >
                  <Undo2 className={ICON_CLASS} style={ICON_STYLE} /> Unmute scope
                </DropdownMenuItem>
              ) : (
                <DropdownMenuGroup aria-label="Mute this scope">
                  <DropdownMenuLabel className="flex items-center gap-2 text-caption font-medium text-fg-tertiary">
                    <BellOff className={ICON_CLASS} aria-hidden="true" /> Mute this scope
                  </DropdownMenuLabel>
                  {MUTE_OPTIONS.map((option) => (
                    <DropdownMenuItem
                      key={option.duration}
                      inset
                      aria-label={`Mute ${option.label.toLowerCase()}`}
                      className="text-body-sm"
                      disabled={triage.isPending}
                      onSelect={() => triage.run(signal, { kind: 'mute', duration: option.duration })}
                    >
                      {option.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {expectedOpen && (
        <ExpectedSignalDialog
          bucket={signal.bucket}
          scopeLabel={signalScopeLabel(signal) ?? unnamedScopeLabel(signal)}
          pending={triage.isPending}
          onClose={() => setExpectedOpen(false)}
          onConfirm={(note) =>
            triage.run(signal, { kind: 'expected', note }, () => setExpectedOpen(false))
          }
        />
      )}
    </>
  )
}
