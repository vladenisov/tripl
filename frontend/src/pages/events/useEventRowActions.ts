import { useCallback, useEffect, useRef } from 'react'
import type { NavigateFunction } from 'react-router-dom'
import { arrayMove } from '@dnd-kit/sortable'
import type { DragEndEvent } from '@dnd-kit/core'

import type { EventListItem } from '@/types'

import type { RowAction } from './EventRow'
import type { EventMutations } from './useEventMutations'

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
  slug,
  navigate,
  openEvent,
  mutations,
  confirm,
  visibleEventIds,
}: {
  slug: string | undefined
  navigate: NavigateFunction
  openEvent: (ev: EventListItem) => void
  mutations: EventMutations
  confirm: ConfirmFn
  visibleEventIds: string[]
}) {
  const rowCtxRef = useRef({
    slug,
    navigate,
    openEvent,
    mutations,
    confirm,
    visibleEventIds,
  })
  useEffect(() => {
    rowCtxRef.current = {
      slug,
      navigate,
      openEvent,
      mutations,
      confirm,
      visibleEventIds,
    }
  })

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return
      const ctx = rowCtxRef.current
      const ids = ctx.visibleEventIds
      const oldIndex = ids.indexOf(String(active.id))
      const newIndex = ids.indexOf(String(over.id))
      if (oldIndex < 0 || newIndex < 0) return
      ctx.mutations.reorderEventsMut.mutate(arrayMove(ids, oldIndex, newIndex))
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
      case 'navigate-monitoring':
        ctx.navigate(`/p/${ctx.slug}/monitoring/event/${ev.id}`)
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
