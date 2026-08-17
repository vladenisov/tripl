import { useCallback } from 'react'

import type { EventMutations } from './useEventMutations'

type ConfirmFn = (options: {
  title: string
  message: string
  variant?: 'danger' | 'primary'
  confirmLabel?: string
}) => Promise<boolean>

/**
 * Deletes the WHOLE selection, including ids that are no longer loaded — that
 * is what "Select all N matching" is for. The confirmation names both numbers
 * whenever they differ, so the operator is never asked to approve a count that
 * exceeds what the table can show them (tripl-4i49).
 */
export function useEventsBulkDelete({
  selectedEventIds,
  selectedVisibleEventIds,
  bulkDeleteMut,
  confirm,
}: {
  selectedEventIds: string[]
  selectedVisibleEventIds: string[]
  bulkDeleteMut: EventMutations['bulkDeleteMut']
  confirm: ConfirmFn
}) {
  return useCallback(async () => {
    if (!selectedEventIds.length) return
    const offScreen = selectedEventIds.length - selectedVisibleEventIds.length
    const ok = await confirm({
      title: 'Delete selected events',
      message:
        offScreen > 0
          ? `Delete ${selectedEventIds.length} selected events? Only ${selectedVisibleEventIds.length} of them are on screen — ${offScreen} are outside the current filter or page.`
          : `Delete ${selectedEventIds.length} selected events?`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) bulkDeleteMut.mutate(selectedEventIds)
  }, [bulkDeleteMut, confirm, selectedEventIds, selectedVisibleEventIds])
}
