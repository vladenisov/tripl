import { Link, useParams } from 'react-router-dom'
import {
  Activity,
  ArrowRight,
  PencilRuler,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react'
import { Chip } from '@/components/primitives/chip'
import { PageHead, Panel } from '@/components/settings/kit'

/**
 * A single domain term: its plain-language definition and, where the concept has
 * a real home in the app, the route segment (relative to `/p/:slug`) it lives at.
 * `surface` overrides the default "Open" link label when the term is only
 * *surfaced* somewhere (e.g. a shadow event appears on the Reconciliation page)
 * rather than having its own dedicated page.
 */
type Term = {
  term: string
  definition: string
  path?: string
  surface?: string
}

type AreaKey = 'plan' | 'observe' | 'govern'

type Area = {
  key: AreaKey
  label: string
  tagline: string
  blurb: string
  icon: LucideIcon
  accent: string
  terms: readonly Term[]
}

/**
 * The three jobs tripl is built around. Plan → Observe → Govern is the spine of
 * the whole product: declare what *should* happen, watch what *actually* does,
 * then keep the two in sync. The glossary and the at-a-glance map below are both
 * driven from this one list so they never drift apart.
 */
const AREAS: readonly Area[] = [
  {
    key: 'plan',
    label: 'Plan',
    tagline: 'what should happen',
    blurb: 'Declare the tracking plan: the events you expect, how they are shaped, and how they relate.',
    icon: PencilRuler,
    accent: 'var(--accent)',
    terms: [
      {
        term: 'Events',
        // No backticks: TermRow prints `definition` as a bare text node, so the
        // grave accents that once wrapped the example rendered as literal
        // characters on the finished reference page (tripl-aqru). The example
        // itself is the one the New event form models in its name placeholder
        // ("e.g. checkout:completed", EventForm.tsx) and the shape scan rules
        // generate from an `event_name_format` — the glossary used to teach a
        // third convention, leaving a first-time user with no idea which the
        // product expects.
        definition:
          'A single tracked action in your plan — checkout:completed, for example. Events are the atomic unit you instrument, observe, and govern.',
        path: '/events',
      },
      {
        term: 'Event types',
        definition:
          'Categories that group related events (for example lifecycle or commerce) so they can be organised and colour-coded together.',
        path: '/settings/event-types',
      },
      {
        term: 'Schema & fields',
        definition:
          'The meta fields an event is expected to carry and their data types — the contract for what a well-formed event looks like.',
        path: '/settings/meta-fields',
      },
      {
        term: 'Variables',
        definition:
          'Reusable named values (thresholds, identifiers, constants) referenced across the plan so a value is defined once and used everywhere.',
        path: '/settings/variables',
      },
      {
        term: 'Relations',
        definition:
          'Declared links between events — one event follows, depends on, or belongs with another — describing how the plan fits together.',
        path: '/settings/relations',
      },
      {
        term: 'Plan branches',
        definition:
          'Isolated copies of the plan you can edit and review before merging, like version-control branches for your tracking plan.',
        path: '/settings/branches',
      },
    ],
  },
  {
    key: 'observe',
    label: 'Observe',
    tagline: 'what actually happens',
    blurb: 'Watch real traffic against the plan: live volume, the scopes it flows through, and anything anomalous.',
    icon: Activity,
    accent: 'var(--info)',
    terms: [
      {
        term: 'Live activity',
        definition:
          'The real-time stream of incoming events and recent plan changes — the first place to see what your data is doing right now.',
        path: '/overview',
      },
      {
        term: 'Scopes',
        definition:
          'The level at which activity and anomalies are measured: the whole project, a single event type, or one event. Signals and monitors are always scoped.',
      },
      {
        term: 'Signals',
        definition:
          'An open anomaly at a given scope — a spike or drop tripl found in the volume. Signals are raised automatically by detection on every scan; no monitor has to exist for one to appear.',
        path: '/anomalies',
        surface: 'Anomalies',
      },
      {
        term: 'Anomalies',
        definition:
          'The page that lists every open signal in the project, newest first. It is the signal inbox — the sidebar badge beside it counts the same open signals.',
        path: '/anomalies',
      },
      {
        term: 'Monitors',
        definition:
          'Alert rules layered on top of detection: a monitor decides which signals matter for a scope and where they are routed, and carries its own live state — firing, warning or healthy. A project with no monitors still raises signals — it just does not notify anyone about them. "Monitor" and "alert rule" name the same object, and it lives on one screen: the Monitors tab of Alerting.',
        path: '/settings/alerting?section=monitors',
      },
      {
        term: 'Alerting',
        definition:
          'Everything that turns a signal into a notification somebody owes an answer on: the incident Inbox, the rules that route, the destinations (Slack, Telegram, webhooks, email, Jira, Linear) they route to, and the delivery log behind them.',
        path: '/settings/alerting',
      },
    ],
  },
  {
    key: 'govern',
    label: 'Govern',
    tagline: 'keep plan & reality in sync',
    blurb: 'Close the gap between plan and traffic: reconcile differences, scan for drift, and keep an audit trail.',
    icon: ShieldCheck,
    accent: 'var(--success)',
    terms: [
      {
        term: 'Reconciliation',
        definition:
          'The workflow of comparing your plan against observed events and resolving the differences — adopting, ignoring, or archiving them.',
        path: '/reconciliation',
      },
      {
        term: 'Shadow events',
        definition:
          'Events arriving in your data that are not declared in the plan — observed but undeclared. They surface during reconciliation so you can adopt or ignore them.',
        path: '/reconciliation',
        surface: 'Reconciliation',
      },
      {
        term: 'Dead events',
        definition:
          'Events declared in the plan that have stopped arriving — planned but unobserved. They are candidates for archiving during reconciliation.',
        path: '/reconciliation',
        surface: 'Reconciliation',
      },
      {
        // The glossary is where someone who does not understand scans arrives on
        // purpose — often straight off a Telegram alert naming one. It has to
        // carry the same chain the scans list, the scan form and a scan's own
        // page carry, in the same words (tripl-3y7z.2). The old definition named
        // plan coverage and dead events and nothing downstream, and called every
        // scan "scheduled" — which a catalog-only scan is not.
        term: 'Scans',
        definition:
          'Warehouse queries that add events and fields to your tracking plan. A monitoring scan also records metric points on a schedule, and those points are what anomaly detection and alerts are built on.',
        path: '/scans',
      },
      {
        term: 'Audit log',
        definition:
          'A chronological record of who changed what in the plan, so every adoption, edit, and archive is traceable.',
        path: '/settings/audit',
      },
    ],
  },
]

function MapCard({ area }: { area: Area }) {
  const Icon = area.icon
  return (
    <div
      className="flex flex-col rounded-[10px] border p-4"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
    >
      <div className="flex items-center gap-2">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
          style={{ background: 'var(--surface-hover)' }}
        >
          <Icon className="h-4 w-4" style={{ color: area.accent }} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <div className="text-[13px] font-semibold leading-tight">{area.label}</div>
          <div className="text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
            {area.tagline}
          </div>
        </div>
      </div>
      <p className="mt-2.5 text-[12px] leading-relaxed" style={{ color: 'var(--fg-subtle)' }}>
        {area.blurb}
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {area.terms.map((t) => (
          <Chip key={t.term} size="xs">
            {t.term}
          </Chip>
        ))}
      </div>
    </div>
  )
}

function TermRow({ term, slug }: { term: Term; slug: string | undefined }) {
  const href = slug && term.path ? `/p/${slug}${term.path}` : undefined
  return (
    <div className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-[13px] font-semibold">{term.term}</h3>
        {href && (
          <Link
            to={href}
            className="flex shrink-0 items-center gap-0.5 text-[11px] font-medium no-underline"
            style={{ color: 'var(--accent)' }}
            aria-label={`Open ${term.term} in the app`}
          >
            {term.surface ?? 'Open'}
            <ArrowRight className="h-3 w-3" aria-hidden="true" />
          </Link>
        )}
      </div>
      <p className="mt-1 text-[12px] leading-relaxed" style={{ color: 'var(--fg-subtle)' }}>
        {term.definition}
      </p>
    </div>
  )
}

export default function ConceptsPage() {
  const { slug } = useParams<{ slug: string }>()

  return (
    <div className="min-w-0 space-y-8 pb-12">
      <PageHead
        eyebrow="Help & reference"
        title="Concepts"
        description="How tripl models your plan. Three jobs turn a tracking plan into something you can trust: plan what should happen, observe what actually does, and govern the gap between them."
      />

      {/* Concept map — the Plan → Observe → Govern spine, with each job's key
          entities listed at a glance. The glossary below defines every term. */}
      <section aria-labelledby="concept-map-heading" className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="concept-map-heading" className="text-[13px] font-semibold">
            How tripl models your plan
          </h2>
          <div
            className="flex items-center gap-1.5 text-[11px] font-medium"
            style={{ color: 'var(--fg-faint)' }}
          >
            {AREAS.map((area, i) => (
              <span key={area.key} className="flex items-center gap-1.5">
                {i > 0 && <ArrowRight className="h-3 w-3" aria-hidden="true" />}
                <span>{area.label}</span>
              </span>
            ))}
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-3">
          {AREAS.map((area) => (
            <MapCard key={area.key} area={area} />
          ))}
        </div>
      </section>

      {/* Glossary — grouped by the same three jobs so the vocabulary maps onto
          the model above. Each term links to where it lives, when it has a home. */}
      <section aria-labelledby="glossary-heading" className="space-y-4">
        <h2 id="glossary-heading" className="text-[13px] font-semibold">
          Glossary
        </h2>
        {AREAS.map((area) => (
          <Panel key={area.key} title={area.label} subtitle={area.tagline}>
            <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
              {area.terms.map((term) => (
                <TermRow key={term.term} term={term} slug={slug} />
              ))}
            </div>
          </Panel>
        ))}
      </section>
    </div>
  )
}
