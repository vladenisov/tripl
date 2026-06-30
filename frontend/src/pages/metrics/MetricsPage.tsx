import { Link, useParams } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageHead } from '@/components/settings/kit'
import { FactTablesList } from '@/pages/fact-tables/FactTablesList'
import { MetricsCatalog } from './MetricsCatalog'

export type MetricsTab = 'catalog' | 'fact-tables'

const TABS: { id: MetricsTab; label: string; path: (slug: string) => string }[] = [
  { id: 'catalog', label: 'Catalog', path: slug => `/p/${slug}/metrics` },
  { id: 'fact-tables', label: 'Fact tables', path: slug => `/p/${slug}/metrics/fact-tables` },
]

/**
 * Metrics surface (area "Observe"). The header + tab bar are URL-driven: each
 * tab is its own route (`/metrics` and `/metrics/fact-tables`), so tabs are
 * deep-linkable and browser back/forward switches them. Fact tables exist only
 * to back fact metrics, so they live here as a tab rather than as a standalone
 * sidebar entry. The body and the primary action are contextual to the active
 * tab; the H1 stays "Metrics" so the breadcrumb reads "Observe › Metrics".
 */
export default function MetricsPage({ tab = 'catalog' }: { tab?: MetricsTab }) {
  const { slug } = useParams<{ slug: string }>()

  const action =
    slug && tab === 'fact-tables' ? (
      <Button asChild size="sm">
        <Link to={`/p/${slug}/metrics/fact-tables/new`} className="no-underline">
          <Plus className="h-3.5 w-3.5" />
          New fact table
        </Link>
      </Button>
    ) : slug ? (
      <Button asChild size="sm">
        <Link to={`/p/${slug}/metrics/new`} className="no-underline">
          <Plus className="h-3.5 w-3.5" />
          New metric
        </Link>
      </Button>
    ) : undefined

  return (
    <div className="min-w-0 space-y-6 pb-12">
      <div className="space-y-4">
        <PageHead eyebrow="Observe" title="Metrics" right={action} />
        <MetricsTabs slug={slug} tab={tab} />
      </div>

      {tab === 'fact-tables' ? <FactTablesList slug={slug} /> : <MetricsCatalog slug={slug} />}
    </div>
  )
}

function MetricsTabs({ slug, tab }: { slug?: string; tab: MetricsTab }) {
  return (
    <div
      role="tablist"
      aria-label="Metrics sections"
      className="flex gap-1 border-b"
      style={{ borderColor: 'var(--border)' }}
    >
      {TABS.map(t => {
        const active = t.id === tab
        return (
          <Link
            key={t.id}
            to={slug ? t.path(slug) : '#'}
            role="tab"
            aria-selected={active}
            aria-current={active ? 'page' : undefined}
            className="-mb-px px-3 py-2 text-[12.5px] font-medium no-underline transition-colors"
            style={{
              color: active ? 'var(--fg)' : 'var(--fg-muted)',
              borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
            }}
          >
            {t.label}
          </Link>
        )
      })}
    </div>
  )
}
