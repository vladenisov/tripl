export interface PlanRevisionEntityCounts {
  event_types: number
  fields: number
  events: number
  variables: number
  meta_fields: number
  relations: number
}

export interface PlanRevisionSummary {
  id: string
  project_id: string
  summary: string
  created_at: string
  created_by: string | null
  entity_counts: PlanRevisionEntityCounts
}

export interface PlanRevisionDetail extends PlanRevisionSummary {
  payload: Record<string, unknown>
}

export type PlanBranchKind = 'main' | 'working'

export type PlanBranchStatus =
  | 'draft'
  | 'ready_for_review'
  | 'changes_requested'
  | 'approved'
  | 'merged'
  | 'closed'

export type PlanBranchTransitionAction =
  | 'submit'
  | 'request_changes'
  | 'approve'
  | 'reopen'
  | 'close'

export interface PlanBranchSummary {
  id: string
  project_id: string
  name: string
  kind: PlanBranchKind
  status: PlanBranchStatus
  description: string
  base_revision_id: string | null
  created_by: string | null
  merged_at: string | null
  merged_by: string | null
  created_at: string
  updated_at: string
}

export interface PlanBranchReviewer {
  id: string
  user_id: string
  created_at: string
}

export interface PlanBranchApproval {
  user_id: string | null
  approved_at: string
  /**
   * The branch changed after this approval, so the merge gate does not count
   * it. Counting rows without checking this shows a quota the merge endpoint
   * rejects — see the approvals chip in BranchesTab.
   */
  stale: boolean
}

export type ResolutionChoice = 'ours' | 'theirs'

export interface PlanBranchConflictField {
  field: string
  base: unknown
  ours: unknown
  theirs: unknown
  choice: ResolutionChoice | null
}

export interface PlanBranchConflictEntity {
  entity_type: string
  name: string
  fields: PlanBranchConflictField[]
}

export interface PlanBranchConflicts {
  entities: PlanBranchConflictEntity[]
  unresolved_count: number
}

export interface PlanBranchMergeResolution {
  id: string
  branch_id: string
  entity_type: string
  entity_name: string
  field_name: string
  choice: ResolutionChoice
  resolved_by: string | null
  created_at: string
}

export interface PlanBranchDetail extends PlanBranchSummary {
  reviewers: PlanBranchReviewer[]
  approvals: PlanBranchApproval[]
}

export interface PlanBranchList {
  items: PlanBranchSummary[]
  total: number
}

export interface ProjectBranchSettings {
  /** Null while the project rides the defaults (row materializes on first PATCH). */
  id: string | null
  project_id: string
  min_approvals: number
  block_self_approval: boolean
  created_at: string | null
  updated_at: string | null
}

export interface PlanBranchComment {
  id: string
  branch_id: string
  parent_id: string | null
  user_id: string | null
  body: string
  created_at: string
  updated_at: string
}

export interface PlanBranchDiffSummary {
  entries: PlanDiffEntry[]
  summary: { added: number; removed: number; changed: number }
  behind_base: boolean
  /** Removed/added pairs the merge will treat as one rename, computed by the
   * same function the merge applies — so the UI reports the merge's decision
   * rather than guessing at it. Absent on responses from an older instance. */
  renames?: PlanDiffRename[]
}

/** One removed/added pair the merge has already decided is a rename. */
export interface PlanDiffRename {
  entity_type: PlanDiffEntityType
  parent: string | null
  removed_name: string
  added_name: string
}

export interface PlanRevisionList {
  items: PlanRevisionSummary[]
  total: number
}

export type PlanDiffEntityType =
  | 'event_type'
  | 'field_definition'
  | 'event'
  | 'variable'
  | 'meta_field'
  | 'relation'

export type PlanDiffKind = 'added' | 'removed' | 'changed'

/** One member of a collection-valued field (an event field value, a tag, a
 * per-event override) that moved. `key` is the member's natural identifier;
 * `before`/`after` carry its value with the key stripped out. */
export interface PlanValueChange {
  key: string
  kind: PlanDiffKind
  before: unknown
  after: unknown
}

/** Raw before/after values for a single changed field (structured mirror of
 * the human-readable `changes` strings). Present on `changed` entries. */
export interface PlanFieldChange {
  field: string
  before: unknown
  after: unknown
  /** Per-member breakdown for collection-valued fields; empty for scalars. */
  items?: PlanValueChange[]
}

export interface PlanDiffEntry {
  entity_type: PlanDiffEntityType
  kind: PlanDiffKind
  name: string
  parent: string | null
  /** Id of the entity the entry describes — branch-side for added/changed,
   * base-side for removed. Null on legacy snapshots that predate id capture. */
  entity_id?: string | null
  changes: string[]
  /** Per-field before/after for `changed` entries; empty/absent otherwise.
   * Optional to match the OpenAPI shape (Pydantic default → not required). */
  field_changes?: PlanFieldChange[]
  /** Full entity state on the base side; null/absent for `added` entries. */
  before?: Record<string, unknown> | null
  /** Full entity state on the branch side; null/absent for `removed` entries. */
  after?: Record<string, unknown> | null
}

export interface PlanDiff {
  revision_id: string
  compare_to: string
  entries: PlanDiffEntry[]
  summary: { added: number; removed: number; changed: number }
}

/**
 * One row of the audit list, with no `payload` — the list response does not
 * carry one. AuditTab renders a payload only for the rows a reader expanded, so
 * a page of them crossed the wire to be displayed nowhere; the row now fetches
 * its own on expand (tripl-5ydt).
 */
export interface AuditEntry {
  id: string
  created_at: string
  user_id: string | null
  user_email: string
  project_id: string | null
  project_slug: string
  /**
   * The plan branch the write was scoped to. Null/empty means the write was NOT
   * made through a branch-scoped request — main, or an action with no
   * plan-branch dimension at all (alerting, scans, data sources, users, API
   * keys) — so it must never be rendered as "main" (tripl-wkwv.6). `branch_id`
   * is nulled when the branch is deleted; `branch_name` is kept verbatim so the
   * trail outlives it.
   */
  branch_id: string | null
  branch_name: string
  action: string
  target_type: string
  target_id: string | null
  target_name: string
}

/** One entry WITH the request payload that produced it: `GET /audit/{id}`. */
export interface AuditEntryDetail extends AuditEntry {
  payload: Record<string, unknown>
}

export interface AuditListResponse {
  items: AuditEntry[]
  total: number
}
