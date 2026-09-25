import { toast } from 'sonner'

import { ApiError } from '@/api/client'
import { stripValueErrorPrefix } from '@/lib/alertStatus'
import { errorToastId } from '@/lib/errorFeedback'
import { getErrorMessage } from '@/lib/utils'

/**
 * The toast for an alerting write that has no dialog to report in (row
 * toggles, deletes, mutes, bulk inbox actions — ALR-6).
 *
 * Those mutations are `SILENT_ERROR_META` so that the message can lose
 * Pydantic's "Value error, " prefix, but going silent also skipped what the
 * global MutationCache backstop (`surfaceError` in lib/errorFeedback.ts) does
 * for every other write, so this keeps it: a 401 stays quiet (the re-auth flow
 * owns it), a request id is quoted for support, and a repeat replaces the
 * toast instead of stacking. Keep it in step with `surfaceError`.
 */
export function toastAlertingWriteError(error: unknown): void {
  if (error instanceof ApiError && error.status === 401) return
  const reference =
    error instanceof ApiError && error.requestId ? `\nReference: ${error.requestId}` : ''
  toast.error(`${stripValueErrorPrefix(getErrorMessage(error))}${reference}`, {
    id: errorToastId(error),
  })
}
