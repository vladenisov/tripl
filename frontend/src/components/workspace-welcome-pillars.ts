import { Activity, ClipboardList, ShieldCheck } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * Product pillars shown on the empty-workspace welcome hero. Lives apart from
 * the component so the constant can be imported by tests (and any future
 * marketing surface) without tripping react-refresh's components-only rule.
 */
export const WELCOME_PILLARS: ReadonlyArray<{
  id: 'plan' | 'observe' | 'govern'
  icon: LucideIcon
  eyebrow: string
  title: string
  description: string
}> = [
  {
    id: 'plan',
    icon: ClipboardList,
    eyebrow: 'Plan',
    title: 'Design what should be tracked',
    description:
      'A searchable catalog of every event, its fields, and typed variables. Changes happen on branches that are reviewed and merged like pull requests, so the live plan is never broken by accident.',
  },
  {
    id: 'observe',
    icon: Activity,
    eyebrow: 'Observe',
    title: 'Watch the real data',
    description:
      "Scans read your warehouse, and anomaly detection learns each event's normal rhythm — flagging spikes, drops, and schema drift automatically. Nothing to configure.",
  },
  {
    id: 'govern',
    icon: ShieldCheck,
    eyebrow: 'Govern',
    title: 'Stay in control',
    description:
      'Reconciliation shows what is documented-but-dead and what arrives undocumented. Coverage, an audit log, roles, and scoped API keys keep the plan honest.',
  },
]
