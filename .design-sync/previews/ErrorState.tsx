import { ErrorState } from 'frontend'

export const Default = () => (
  <div style={{ width: 520 }}>
    <ErrorState
      title="Couldn’t load reconciliation"
      error={new Error('Query timed out after 30s — warehouse connection pool exhausted')}
      description="The last scan failed to read from ClickHouse. Retrying usually clears a transient pool issue."
      onRetry={() => {}}
    />
  </div>
)

export const Compact = () => (
  <div style={{ width: 380 }}>
    <ErrorState
      compact
      title="Failed to refresh metrics"
      error={new Error('HTTP 503 from analytics-api')}
      onRetry={() => {}}
      retryLabel="Retry"
    />
  </div>
)

export const NoRetry = () => (
  <div style={{ width: 520 }}>
    <ErrorState
      title="Access denied"
      error={new Error('You do not have permission to view this project’s plan rules')}
      description="Ask a workspace owner to grant you the editor role to continue."
    />
  </div>
)
