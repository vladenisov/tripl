import { api } from './client'
import type {
  PlanBranchComment,
  PlanBranchConflicts,
  PlanBranchDetail,
  PlanBranchDiffSummary,
  PlanBranchList,
  PlanBranchMergeResolution,
  PlanBranchReviewer,
  PlanBranchSummary,
  PlanBranchTransitionAction,
  PlanDiffEntityType,
  ResolutionChoice,
} from '../types'

export const planBranchesApi = {
  list: (slug: string) =>
    api.get<PlanBranchList>(`/projects/${slug}/branches`),

  get: (slug: string, branchId: string) =>
    api.get<PlanBranchDetail>(`/projects/${slug}/branches/${branchId}`),

  create: (slug: string, data: { name: string; description?: string }) =>
    api.post<PlanBranchSummary>(`/projects/${slug}/branches`, data),

  delete: (slug: string, branchId: string) =>
    api.del(`/projects/${slug}/branches/${branchId}`),

  transition: (
    slug: string,
    branchId: string,
    action: PlanBranchTransitionAction,
  ) =>
    api.post<PlanBranchDetail>(
      `/projects/${slug}/branches/${branchId}/transition`,
      { action },
    ),

  addReviewer: (slug: string, branchId: string, userId: string) =>
    api.post<PlanBranchReviewer>(
      `/projects/${slug}/branches/${branchId}/reviewers`,
      { user_id: userId },
    ),

  removeReviewer: (slug: string, branchId: string, userId: string) =>
    api.del(`/projects/${slug}/branches/${branchId}/reviewers/${userId}`),

  listComments: (slug: string, branchId: string) =>
    api.get<PlanBranchComment[]>(
      `/projects/${slug}/branches/${branchId}/comments`,
    ),

  createComment: (
    slug: string,
    branchId: string,
    body: string,
    parentId?: string,
  ) =>
    api.post<PlanBranchComment>(
      `/projects/${slug}/branches/${branchId}/comments`,
      { body, parent_id: parentId ?? null },
    ),

  deleteComment: (slug: string, branchId: string, commentId: string) =>
    api.del(
      `/projects/${slug}/branches/${branchId}/comments/${commentId}`,
    ),

  diff: (slug: string, branchId: string) =>
    api.get<PlanBranchDiffSummary>(
      `/projects/${slug}/branches/${branchId}/diff`,
    ),

  merge: (slug: string, branchId: string) =>
    api.post<PlanBranchDetail>(
      `/projects/${slug}/branches/${branchId}/merge`,
      undefined,
    ),

  /** Undo one entry of the branch's diff — the whole entity, or one field of it
   * — back to the branch's base state. Responds with the resulting diff. */
  revert: (
    slug: string,
    branchId: string,
    data: {
      entity_type: PlanDiffEntityType
      name: string
      parent?: string | null
      field?: string | null
    },
  ) =>
    api.post<PlanBranchDiffSummary>(
      `/projects/${slug}/branches/${branchId}/revert`,
      data,
    ),

  getConflicts: (slug: string, branchId: string) =>
    api.get<PlanBranchConflicts>(
      `/projects/${slug}/branches/${branchId}/conflicts`,
    ),

  saveResolution: (
    slug: string,
    branchId: string,
    data: {
      entity_type: string
      entity_name: string
      field_name: string
      choice: ResolutionChoice
    },
  ) =>
    api.post<PlanBranchMergeResolution>(
      `/projects/${slug}/branches/${branchId}/resolutions`,
      data,
    ),

  deleteResolution: (slug: string, branchId: string, resolutionId: string) =>
    api.del(
      `/projects/${slug}/branches/${branchId}/resolutions/${resolutionId}`,
    ),
}
