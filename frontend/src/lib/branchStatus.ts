// Branch status wording and chip tone, shared by the shell (branch switcher,
// top-bar branch strip) and the Plan branches pages. It lives in lib/ so the
// app shell does not import a settings page module into the entry chunk.
import type { ChipTone } from '@/components/primitives/chip'
import type { PlanBranchStatus } from '@/types'

export const STATUS_LABEL: Record<PlanBranchStatus, string> = {
  draft: 'Draft',
  ready_for_review: 'Ready for review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  merged: 'Merged',
  closed: 'Closed',
}

export const STATUS_TONE: Record<PlanBranchStatus, ChipTone> = {
  draft: 'neutral',
  ready_for_review: 'info',
  changes_requested: 'danger',
  approved: 'success',
  merged: 'neutral',
  closed: 'neutral',
}
