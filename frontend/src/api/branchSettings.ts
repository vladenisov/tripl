import { api } from './client'
import type { ProjectBranchSettings } from '../types'

export const branchSettingsApi = {
  get: (slug: string) =>
    api.get<ProjectBranchSettings>(`/projects/${slug}/branch-settings`),

  update: (
    slug: string,
    data: Partial<{
      min_approvals: number
      block_self_approval: boolean
    }>,
  ) => api.patch<ProjectBranchSettings>(`/projects/${slug}/branch-settings`, data),
}
