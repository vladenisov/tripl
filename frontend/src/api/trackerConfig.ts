import { api } from './client'
import type { ProjectTrackerConfig, ProjectTrackerConfigUpdate } from '@/types'

export const trackerConfigApi = {
  get: (slug: string) => api.get<ProjectTrackerConfig>(`/projects/${slug}/tracker-config`),

  update: (slug: string, data: ProjectTrackerConfigUpdate) =>
    api.patch<ProjectTrackerConfig>(`/projects/${slug}/tracker-config`, data),
}
