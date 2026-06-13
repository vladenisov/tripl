import {
  Activity,
  Bell,
  Braces,
  Database,
  Gauge,
  GitBranch,
  GitCompare,
  ScrollText,
  Table2,
  Tag,
  type LucideIcon,
} from 'lucide-react'
import type { ProjectSummary } from '@/types'

/**
 * Shared navigation model for the job-based information architecture
 * (Plan / Observe / Govern / Connect). Both the sidebar (rendering) and the
 * top-bar breadcrumbs (area resolution) consume this so the two stay in sync.
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
 * Build the four job-based groups for a project. Each item maps to a route that
 * already exists — the IA redesign gives every major surface a first-class home
 * instead of burying it under a flat "Settings" tab list. Counts/tones come from
 * the cheap project summary; surfaces without a backing count omit it.
 */
export function buildNavGroups(slug: string, summary: ProjectSummary | undefined): NavGroup[] {
  const base = `/p/${slug}`
  const signals = summary?.monitoring_signal_count ?? 0
  const destinations = summary?.alert_destination_count ?? 0

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
          match: (p) =>
            p.startsWith(`${base}/settings/meta-fields`)
            || p.startsWith(`${base}/settings/variables`)
            || p.startsWith(`${base}/settings/relations`),
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
          label: 'Overview',
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
          count: signals > 0 ? formatCount(signals) : undefined,
          tone: signals > 0 ? 'danger' : undefined,
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
          id: 'audit',
          label: 'Audit log',
          icon: ScrollText,
          href: `${base}/settings/audit`,
          match: (p) => p.startsWith(`${base}/settings/audit`),
        },
      ],
    },
    {
      label: 'Connect',
      items: [
        {
          id: 'data-sources',
          label: 'Data sources',
          icon: Database,
          href: '/settings/data-sources',
          match: (p) => p.startsWith('/settings/data-sources') || p.startsWith('/data-sources'),
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
