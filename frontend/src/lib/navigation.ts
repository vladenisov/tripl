import {
  Activity,
  AlertTriangle,
  Bell,
  Braces,
  Gauge,
  GitBranch,
  GitCompare,
  LineChart,
  Link2,
  ScrollText,
  Search,
  ShieldCheck,
  Table2,
  Tag,
  Variable,
  type LucideIcon,
} from 'lucide-react'
import type { ProjectSummary } from '@/types'

/**
 * Shared navigation model for the job-based information architecture
 * (Plan / Observe / Govern). Both the sidebar (rendering) and the top-bar
 * breadcrumbs (area resolution) consume this so the two stay in sync.
 */

export type NavTone = 'danger' | 'warning' | 'accent' | 'info'

export type NavItem = {
  id: string
  label: string
  icon: LucideIcon
  href: string
  match: (path: string) => boolean
  count?: string
  tone?: NavTone
}

export type NavGroup = { label: string; items: NavItem[] }

export function formatCount(n: number): string {
  if (n >= 1000) {
    const k = n / 1000
    return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`
  }
  return String(n)
}

/**
 * Build the three job-based groups for a project. Each item maps to a route that
 * already exists — the IA redesign gives every major surface a first-class home
 * instead of burying it under a flat "Settings" tab list. Counts/tones come from
 * the cheap project summary; surfaces without a backing count omit it. Data
 * sources / API keys are genuine configuration, so they live in workspace
 * Settings rather than as a top-level "Connect" nav group.
 */
export function buildNavGroups(slug: string, summary: ProjectSummary | undefined): NavGroup[] {
  const base = `/p/${slug}`
  const destinations = summary?.alert_destination_count ?? 0
  const firingMonitors = summary?.firing_monitor_count ?? 0
  const openSignals = summary?.monitoring_signal_count ?? 0

  return [
    {
      label: 'Plan',
      items: [
        {
          id: 'events',
          label: 'Events',
          icon: Table2,
          href: `${base}/events`,
          match: (p) => p === base || p.startsWith(`${base}/events`),
          count: summary ? formatCount(summary.active_event_count) : undefined,
        },
        {
          id: 'event-types',
          label: 'Event types',
          icon: Tag,
          href: `${base}/settings/event-types`,
          match: (p) => p.startsWith(`${base}/settings/event-types`),
          count: summary ? formatCount(summary.event_type_count) : undefined,
        },
        {
          id: 'schema',
          label: 'Schema & fields',
          icon: Braces,
          href: `${base}/settings/meta-fields`,
          match: (p) => p.startsWith(`${base}/settings/meta-fields`),
        },
        {
          id: 'variables',
          label: 'Variables',
          icon: Variable,
          href: `${base}/settings/variables`,
          match: (p) => p.startsWith(`${base}/settings/variables`),
          count: summary ? formatCount(summary.variable_count) : undefined,
        },
        {
          id: 'relations',
          label: 'Relations',
          icon: Link2,
          href: `${base}/settings/relations`,
          match: (p) => p.startsWith(`${base}/settings/relations`),
        },
        {
          id: 'branches',
          label: 'Plan branches',
          icon: GitBranch,
          href: `${base}/settings/branches`,
          match: (p) => p.startsWith(`${base}/settings/branches`),
        },
      ],
    },
    {
      label: 'Observe',
      items: [
        {
          id: 'overview',
          label: 'Live activity',
          icon: Activity,
          href: `${base}/overview`,
          match: (p) => p.startsWith(`${base}/overview`),
        },
        {
          id: 'monitoring',
          label: 'Monitors',
          icon: Gauge,
          href: `${base}/monitors`,
          match: (p) =>
            p.startsWith(`${base}/monitors`)
            || p.startsWith(`${base}/monitoring`)
            || p.startsWith(`${base}/settings/monitoring`),
          // The badge counts MONITORS in a FIRING state (firing_monitor_count),
          // never the open-signal population (monitoring_signal_count) — that
          // produced "Monitors 5" beside a Monitors page showing 1 monitor. This
          // keeps the badge equal to the Monitors page firing_count; omitted (no
          // count, no tone) when nothing is firing.
          count: firingMonitors > 0 ? formatCount(firingMonitors) : undefined,
          tone: firingMonitors > 0 ? 'danger' : undefined,
        },
        {
          id: 'metrics',
          label: 'Metrics',
          icon: LineChart,
          href: `${base}/metrics`,
          match: (p) => p.startsWith(`${base}/metrics`),
        },
        {
          id: 'anomalies',
          label: 'Anomalies',
          icon: AlertTriangle,
          href: `${base}/anomalies`,
          match: (p) => p.startsWith(`${base}/anomalies`),
          // Badges the open-signal population (monitoring_signal_count) — the raw
          // anomalies feed this page lists — in a danger tone when any are open.
          // This is deliberately the signal count, not firing_monitor_count: that
          // one belongs to Monitors above. Omitted when nothing is open.
          count: openSignals > 0 ? formatCount(openSignals) : undefined,
          tone: openSignals > 0 ? 'danger' : undefined,
        },
        {
          id: 'alerting',
          label: 'Alerting',
          icon: Bell,
          href: `${base}/settings/alerting`,
          match: (p) => p.startsWith(`${base}/settings/alerting`),
          count: destinations > 0 ? formatCount(destinations) : undefined,
        },
      ],
    },
    {
      label: 'Govern',
      items: [
        {
          id: 'reconciliation',
          label: 'Reconciliation',
          icon: GitCompare,
          href: `${base}/reconciliation`,
          match: (p) => p.startsWith(`${base}/reconciliation`),
        },
        {
          id: 'coverage',
          label: 'Coverage',
          icon: ShieldCheck,
          href: `${base}/coverage`,
          match: (p) => p.startsWith(`${base}/coverage`),
        },
        {
          id: 'scans',
          label: 'Scans',
          icon: Search,
          href: `${base}/settings/scans`,
          match: (p) => p.startsWith(`${base}/settings/scans`),
        },
        {
          id: 'audit',
          label: 'Audit log',
          icon: ScrollText,
          href: `${base}/settings/audit`,
          match: (p) => p.startsWith(`${base}/settings/audit`),
        },
      ],
    },
  ]
}

/**
 * Resolve which nav area (group) and item a project-scoped pathname belongs to,
 * for breadcrumbs like "project › Plan › Events". Returns null when no grouped
 * nav item matches (e.g. project general settings, overview).
 */
export function resolveNavLocation(
  slug: string,
  pathname: string,
): { area: string; label: string } | null {
  for (const group of buildNavGroups(slug, undefined)) {
    for (const item of group.items) {
      if (item.match(pathname)) {
        return { area: group.label, label: item.label }
      }
    }
  }
  return null
}
