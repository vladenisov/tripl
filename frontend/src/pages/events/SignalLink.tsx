import { Link } from 'react-router-dom'
import { AlertTriangle, ArrowDown, ArrowUp } from 'lucide-react'
import type { MonitoringSignal } from '@/types'
import { getMonitoringPath } from '@/lib/monitoring'
import { getSignalTone } from './utils'

export function SignalLink({
  slug,
  signal,
  compact = false,
}: {
  slug: string
  signal: MonitoringSignal | null | undefined
  compact?: boolean
}) {
  if (!signal) return null

  const tone = getSignalTone(signal)
  const CompactIcon = signal.direction === 'spike' ? ArrowUp : ArrowDown

  return (
    <Link
      to={getMonitoringPath(slug, signal)}
      className={compact
        ? `relative top-px inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center ${tone.compact}`
        : `inline-flex h-5 w-5 items-center justify-center rounded-full ${tone.regular}`}
      title={tone.title}
      aria-label={tone.title}
    >
      {compact ? <CompactIcon className="h-3.5 w-3.5 stroke-[2.25]" /> : <AlertTriangle className="h-3 w-3" />}
    </Link>
  )
}
