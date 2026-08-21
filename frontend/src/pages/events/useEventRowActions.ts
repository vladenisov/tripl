import { useCallback, useEffect, useRef } from 'react'
import type { DragEndEvent } from '@dnd-kit/core'

import type { EventListItem } from '@/types'

import type { RowAction } from './EventRow'
import type { EventMutations } from './useEventMutations'
import { reorderWithSelection } from './utils'

type ConfirmFn = (options: {
  title: string
  message: string
  variant?: 'danger' | 'primary'
  confirmLabel?: string
}) => Promise<boolean>

/**
 * Bundles the row-level dispatch + drag-end handler for the events table.
 * Uses a ref so the resulting callbacks have stable identity across parent
 * re-renders, which keeps `React.memo` on EventRow effective.
 */
export function useEventRowActions({
  openEvent,
  mutations,
  confirm,
  visibleEventIds,
  selectedSet,
}: {
  openEvent: (ev: EventListItem) => void
  mutations: EventMutations
  confirm: ConfirmFn
  visibleEventIds: string[]
  selectedSet: Set<string>
}) {
  const rowCtxRef = useRef({
    openEvent,
    mutations,
    confirm,
    visibleEventIds,
    selectedSet,
  })
  useEffect(() => {
    rowCtxRef.current = {
      openEvent,
      mutations,
      confirm,
      visibleEventIds,
      selectedSet,
    }
  })

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over) return
      const ctx = rowCtxRef.current
      // Multi-select drag moves the whole selection as a block; a single row
      // moves on its own. `reorderWithSelection` returns null when there is
      // nothing to apply.
      const next = reorderWithSelection(
        ctx.visibleEventIds,
        ctx.selectedSet,
        String(active.id),
        String(over.id),
      )
      if (next) ctx.mutations.reorderEventsMut.mutate(next)
    },
    [],
  )

  const onRowAction = useCallback((action: RowAction, ev: EventListItem) => {
    const ctx = rowCtxRef.current
    const { mutations } = ctx
    switch (action) {
      case 'edit':
        ctx.openEvent(ev)
        return
      case 'move-up':
        mutations.moveEventMut.mutate({ id: ev.id, direction: 'up', visibleEventIds: ctx.visibleEventIds })
        return
      case 'move-down':
        mutations.moveEventMut.mutate({ id: ev.id, direction: 'down', visibleEventIds: ctx.visibleEventIds })
        return
      case 'set-status-archived':
        mutations.setStatusMut.mutate({ id: ev.id, status: 'archived' })
        return
      case 'set-status-draft':
        mutations.setStatusMut.mutate({ id: ev.id, status: 'draft' })
        return
      case 'delete': {
        void (async () => {
          const ok = await ctx.confirm({
            title: 'Delete event',
            message: `Are you sure you want to delete "${ev.name}"?`,
            confirmLabel: 'Delete',
            variant: 'danger',
          })
          if (ok) mutations.deleteMut.mutate(ev.id)
        })()
        return
      }
    }
  }, [])

  return { handleDragEnd, onRowAction }
}
