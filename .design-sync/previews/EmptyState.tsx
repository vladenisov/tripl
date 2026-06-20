import { EmptyState, Button } from 'frontend'
import { Inbox, DatabaseZap, SearchX } from 'lucide-react'

export const Default = () => (
  <div style={{ width: 460, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface)' }}>
    <EmptyState
      icon={Inbox}
      title="No reconciliations yet"
      description="Connect a warehouse and run your first scan to see drift between expected and observed events."
    />
  </div>
)

export const WithAction = () => (
  <div style={{ width: 460, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface)' }}>
    <EmptyState
      icon={DatabaseZap}
      title="No data sources connected"
      description="Tripl needs a ClickHouse or BigQuery connection to start monitoring your event pipeline."
      action={<Button size="sm">Connect a source</Button>}
    />
  </div>
)

export const NoSearchResults = () => (
  <div style={{ width: 460, border: '1px solid var(--border)', borderRadius: 12, background: 'var(--surface)' }}>
    <EmptyState
      icon={SearchX}
      title="No events match “checkout_completed”"
      description="Try a broader query or clear the active filters to widen the search."
      action={
        <Button size="sm" variant="outline">
          Clear filters
        </Button>
      }
    />
  </div>
)
