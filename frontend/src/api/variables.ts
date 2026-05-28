import { api, withBranch } from './client'
import type { Variable, VariableType } from '../types'

export const variablesApi = {
  list: (slug: string, branchId?: string | null) =>
    api.get<Variable[]>(withBranch(`/projects/${slug}/variables`, branchId)),
  create: (
    slug: string,
    data: { name: string; variable_type?: VariableType; description?: string },
    branchId?: string | null,
  ) => api.post<Variable>(withBranch(`/projects/${slug}/variables`, branchId), data),
  update: (
    slug: string,
    id: string,
    data: { name?: string; variable_type?: VariableType; description?: string },
    branchId?: string | null,
  ) => api.patch<Variable>(withBranch(`/projects/${slug}/variables/${id}`, branchId), data),
  del: (slug: string, id: string, branchId?: string | null) =>
    api.del(withBranch(`/projects/${slug}/variables/${id}`, branchId)),
}
