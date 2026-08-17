/**
 * Persistent demo banner (tripl-2su6.9).
 *
 * Shown across every surface of a demo project (mounted in the app Layout). It
 * makes the workspace's synthetic/local nature unmistakable, shows the recipe
 * version and runtime freshness, and exposes Reset / Delete — both confirmed,
 * both scoped to the demo endpoints, both offered only to the demo's creator or
 * a workspace owner. On delete it returns to the Projects list.
 *
 * It also owns the one way back into the guided onboarding (tripl-imco): being
 * mounted on every demo surface, it is the only place that can undo the welcome
 * panel's single unconfirmed dismissal.
 */

import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, Compass, RotateCcw, Trash2 } from 'lucide-react'
import { projectsApi } from '@/api/projects'
import { useAuth } from '@/components/auth-context'
import { Chip } from '@/components/primitives/chip'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useBranchContext } from '@/hooks/useBranch'
import { useConfirm } from '@/hooks/useConfirm'
import { formatRelativeTime } from '@/lib/datetime'
import { getErrorMessage } from '@/lib/utils'
import type { Project } from '@/types'
import { ProductTour } from './ProductTour'
import { ProvisioningPhaseList } from './ProvisioningPhaseList'
import { DemoDataBadge } from './capabilityBadges'
import { useDemoScenarioActions } from './demoScenarioContext'
import { DEMO_PROVISION_ESTIMATE } from './provisioningPhases'
import { useEstimatedPhase } from './useEstimatedPhase'
import { setWelcomeDismissed } from './welcomeDismissal'

/**
 * Reset is a single blocking ~10 s POST that re-seeds the whole recipe in one
 * transaction (deliberately, for atomicity). A button that just says "Resetting…"
 * for ten seconds reads as a hang, so the wait gets the same estimated-phase
 * narration the create dialog uses (tripl-jfm3.75). It is not dismissable: unlike
 * a create there is nothing to abandon — the demo is already mid-replacement.
 */
function DemoResetProgressDialog() {
  // Mounted only while the reset is in flight, so every run narrates from the
  // first phase.
  const phaseIndex = useEstimatedPhase()
  return (
    <Dialog open>
      <DialogContent className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Re-seeding demo workspace</DialogTitle>
          <DialogDescription>
            Replacing this demo&apos;s content with a fresh synthetic dataset. This takes{' '}
            {DEMO_PROVISION_ESTIMATE}.
          </DialogDescription>
        </DialogHeader>
        <ProvisioningPhaseList phaseIndex={phaseIndex} />
      </DialogContent>
    </Dialog>
  )
}

const DEMO_LIMITS: readonly string[] = [
  'Alert destinations record deliveries locally and are badged “Local · simulated” — nothing is sent to Slack, Jira or email.',
  'The synthetic warehouse supports common SQL; unsupported queries return a clear capability error instead of silently failing.',
  'Implementation-ticket creation and AI features stay off until you connect a real tracker / enable AI on the server.',
]

export function DemoBanner({ project }: { project: Project }) {
  const { user } = useAuth()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { setBranchId } = useBranchContext()
  const { confirm, dialog } = useConfirm()
  const { resetScenario } = useDemoScenarioActions()
  const [limitsOpen, setLimitsOpen] = useState(false)
  const [tourOpen, setTourOpen] = useState(false)

  const canManage =
    user?.role === 'owner' ||
    (user?.id != null && user.id === project.created_by_user_id)

  const resetMut = useMutation({
    mutationFn: () => projectsApi.resetDemo(project.slug),
    onSuccess: () => {
      // A re-seed rewrites every entity with a NEW id, so anything still holding
      // an old one now points at a deleted row (tripl-2su6.14):
      //   - the branch id persisted in localStorage would make every
      //     branch-aware query fail with "Branch not found", so drop it;
      //   - the banner is mounted on every surface, so a reset can be triggered
      //     from a metric/event/scan detail page whose URL carries a now-dead
      //     id — leave for the overview rather than render a 404.
      setBranchId(null)
      void navigate(`/p/${project.slug}/overview`)
      // Every cached row describes a deleted entity now — drop them outright
      // rather than merely marking them stale.
      queryClient.removeQueries()
      // The guidance is data too (tripl-imco): a re-seeded demo that came back
      // with every chapter still marked completed and the welcome panel still
      // dismissed was a fresh dataset with no way left into the coaching.
      resetScenario()
      setWelcomeDismissed(project.slug, false)
    },
  })

  const deleteMut = useMutation({
    mutationFn: () => projectsApi.deleteDemo(project.slug),
    onSuccess: () => {
      // The project is gone; leave no branch selection behind pointing into it.
      setBranchId(null)
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      void navigate('/workspace')
    },
  })

  const busy = resetMut.isPending || deleteMut.isPending

  const handleReset = async () => {
    const ok = await confirm({
      title: 'Reset demo workspace',
      message:
        'Re-seed this demo from scratch. All current events, metrics, monitors and alerts in the demo are replaced with a fresh synthetic dataset. ' +
        `This runs in one go and takes ${DEMO_PROVISION_ESTIMATE}. It cannot be undone.`,
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

  // demo_seeded_at is floored to the hour — the runtime tick anchors its bucket
  // grid to it — so using it as a freshness stamp made a demo created at 10:59
  // read "refreshed 59m ago" the instant it appeared, and runtime ticks never
  // moved it. demo_last_tick_at is when the data was actually last advanced;
  // until the first tick there is nothing to claim, so say so (tripl-2su6.17).
  const freshnessLabel = project.demo_last_tick_at
    ? `updated ${formatRelativeTime(project.demo_last_tick_at)}`
    : 'freshly seeded'

  const mutationError = resetMut.error ?? deleteMut.error

  return (
    <div
      className="mb-4 rounded-lg border"
      style={{ background: 'var(--warning-soft)', borderColor: 'var(--warning)' }}
    >
      {dialog}
      {resetMut.isPending && <DemoResetProgressDialog />}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2.5">
        <DemoDataBadge />
        <span className="text-[12px] font-medium">Demo workspace</span>
        {project.demo_recipe_version && (
          <Chip tone="neutral" size="xs" title="Demo recipe version">
            recipe {project.demo_recipe_version}
          </Chip>
        )}
        <span className="text-[11.5px]" style={{ color: 'var(--fg-muted)' }}>
          {freshnessLabel}
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

        {/* The only way back into the guided onboarding (tripl-imco). Dismissing
            the welcome panel — one unconfirmed X directly under this banner —
            used to remove the tour and the chapter picker for good; nothing in
            the app cleared `tripl-demo-welcome-dismissed:`, so the documented
            "restart it whenever you like from the welcome panel" needed
            devtools. Offered to everyone: restoring guidance is not managing
            the demo. */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setWelcomeDismissed(project.slug, false)
            setTourOpen(true)
          }}
        >
          <Compass className="h-3.5 w-3.5" />
          Tour &amp; chapters
        </Button>

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

      {/* Mounted only while open so it reads its persisted step position fresh:
          the Overview hosts a second ProductTour, and a permanently-mounted one
          here would keep whatever index it captured at first render. */}
      {tourOpen && <ProductTour slug={project.slug} open onOpenChange={setTourOpen} />}
    </div>
  )
}
