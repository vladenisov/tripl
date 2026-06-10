import { api } from './client'
import type { Project } from '../types'

export const projectsApi = {
  list: () => api.get<Project[]>('/projects'),
  get: (slug: string) => api.get<Project>(`/projects/${slug}`),
  create: (data: { name: string; slug: string; description?: string }) =>
    api.post<Project>('/projects', data),
  createDemo: () => api.post<Project>('/projects/demo', {}),
  update: (slug: string, data: { name?: string; slug?: string; description?: string }) =>
    api.patch<Project>(`/projects/${slug}`, data),
  del: (slug: string) => api.del(`/projects/${slug}`),
}
