import { getErrorMessage } from '@/lib/utils'

/** The footer status of a settings card: a failed save as an alert, or "Saved". */
export function SaveStatus({ error, saved }: { error: unknown; saved: boolean }) {
  if (error != null) {
    return (
      <span role="alert" className="flex-1 text-[12px]" style={{ color: 'var(--danger)' }}>
        {getErrorMessage(error)}
      </span>
    )
  }
  return (
    <span role="status" className="flex-1 text-[12px]" style={{ color: 'var(--success)' }}>
      {saved ? 'Saved' : ''}
    </span>
  )
}
