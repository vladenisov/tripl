import { useCallback } from 'react'

import type { EventMutations } from './useEventMutations'

type ConfirmFn = (options: {
  title: string
  message: string
  variant?: 'danger' | 'primary'
  confirmLabel?: string
}) => Promise<boolean>

export function useEventsBulkDelete({
  selectedVisibleEventIds,
  bulkDeleteMut,
  confirm,
}: {
  selectedVisibleEventIds: string[]
  bulkDeleteMut: EventMutations['bulkDeleteMut']
  confirm: ConfirmFn
}) {
  return useCallback(async () => {
    if (!selectedVisibleEventIds.length) return
    const ok = await confirm({
      title: 'Delete selected events',
      message: `Delete ${selectedVisibleEventIds.length} selected events?`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) bulkDeleteMut.mutate(selectedVisibleEventIds)
  }, [bulkDeleteMut, confirm, selectedVisibleEventIds])
}
