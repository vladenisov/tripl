/**
 * Persistent demo banner (tripl-2su6.9).
 *
 * Shown across every surface of a demo project (mounted in the app Layout). It
 * makes the workspace's synthetic/local nature unmistakable, shows the recipe
 * version and runtime freshness, and exposes Reset / Delete — both confirmed,
 * both scoped to the demo endpoints, both offered only to the demo's creator or
 * a workspace owner. On delete it returns to the Projects list.
 */

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, RotateCcw, Trash2 } from 'lucide-react'
import { projectsApi } from '@/api/projects'
import { useAuth } from '@/components/auth-context'
import { Chip } from '@/components/primitives/chip'
import { Button } from '@/components/ui/button'
import { useConfirm } from '@/hooks/useConfirm'
import { formatRelativeTime } from '@/lib/datetime'
import { getErrorMessage } from '@/lib/utils'
import type { Project } from '@/types'
import { DemoDataBadge } from './capabilityBadges'

const DEMO_LIMITS: readonly string[] = [
  'Alert destinations record deliveries locally and are badged “Local · simulated” — nothing is sent to Slack, Jira or email.',
  'The synthetic warehouse supports common SQL; unsupported queries return a clear capability error instead of silently failing.',
  'Implementation-ticket creation and AI features stay off until you connect a real tracker / enable AI on the server.',
]

export function DemoBanner({ project }: { project: Project }) {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { confirm, dialog } = useConfirm()
  const [limitsOpen, setLimitsOpen] = useState(false)

  const canManage =
    user?.role === 'owner' ||
    (user?.id != null && user.id === project.created_by_user_id)

  const resetMut = useMutation({
    mutationFn: () => projectsApi.resetDemo(project.slug),
    onSuccess: () => {
      // A re-seed rewrites data across every surface — refresh everything.
      void queryClient.invalidateQueries()
    },
  })

  const deleteMut = useMutation({
    mutationFn: () => projectsApi.deleteDemo(project.slug),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      void navigate('/workspace')
    },
  })

  const busy = resetMut.isPending || deleteMut.isPending

  const handleReset = async () => {
    const ok = await confirm({
      title: 'Reset demo workspace',
      message:
        'Re-seed this demo from scratch. All current events, metrics, monitors and alerts in the demo are replaced with a fresh synthetic dataset. This cannot be undone.',
      confirmLabel: 'Reset demo',
      variant: 'primary',
    })
    if (ok) resetMut.mutate()
  }

  const handleDelete = async () => {
    const ok = await confirm({
      title: 'Delete demo workspace',
      message: `Permanently delete “${project.name}” and its synthetic warehouse. You'll be returned to the projects list.`,
      confirmLabel: 'Delete demo',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate()
  }

  const seededLabel = project.demo_seeded_at
    ? `refreshed ${formatRelativeTime(project.demo_seeded_at)}`
    : 'freshly seeded'

  const mutationError = resetMut.error ?? deleteMut.error

  return (
    <div
      className="mb-4 rounded-lg border"
      style={{ background: 'var(--warning-soft)', borderColor: 'var(--warning)' }}
    >
      {dialog}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2.5">
        <DemoDataBadge />
        <span className="text-[12px] font-medium">Demo workspace</span>
        {project.demo_recipe_version && (
          <Chip tone="neutral" size="xs" title="Demo recipe version">
            recipe {project.demo_recipe_version}
          </Chip>
        )}
        <span className="text-[11.5px]" style={{ color: 'var(--fg-muted)' }}>
          {seededLabel}
        </span>

        <button
          type="button"
          onClick={() => setLimitsOpen((open) => !open)}
          aria-expanded={limitsOpen}
          className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--surface-hover)]"
          style={{ color: 'var(--fg-muted)' }}
        >
          What’s simulated
          <ChevronDown
            className="h-3 w-3 transition-transform"
            style={{ transform: limitsOpen ? 'rotate(180deg)' : 'none' }}
          />
        </button>

        {canManage && (
          <div className="flex items-center gap-1.5">
            <Button type="button" variant="outline" size="sm" onClick={() => void handleReset()} disabled={busy}>
              <RotateCcw className="h-3.5 w-3.5" />
              {resetMut.isPending ? 'Resetting…' : 'Reset'}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleDelete()}
              disabled={busy}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {deleteMut.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        )}
      </div>

      {mutationError && (
        <p className="px-3.5 pb-2 text-[11.5px]" style={{ color: 'var(--danger)' }} role="alert">
          {getErrorMessage(mutationError)}
        </p>
      )}

      {limitsOpen && (
        <ul
          className="space-y-1 border-t px-3.5 py-2.5 text-[11.5px] leading-[1.45]"
          style={{ borderColor: 'var(--warning)', color: 'var(--fg-muted)' }}
        >
          {DEMO_LIMITS.map((limit) => (
            <li key={limit} className="flex gap-1.5">
              <span aria-hidden="true">·</span>
              <span>{limit}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
