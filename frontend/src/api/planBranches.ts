import { api } from './client'
import type {
  PlanBranchComment,
  PlanBranchDetail,
  PlanBranchDiffSummary,
  PlanBranchList,
  PlanBranchReviewer,
  PlanBranchSummary,
  PlanBranchTransitionAction,
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
}
