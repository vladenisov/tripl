import { api, withBranch } from './client'
import type { Variable, VariableType, VariableValueContext } from '../types'

export const variablesApi = {
  list: (slug: string, branchId?: string | null) =>
    api.get<Variable[]>(withBranch(`/projects/${slug}/variables`, branchId)),
  create: (
    slug: string,
    data: {
      name: string
      variable_type?: VariableType
      description?: string
      allowed_values?: string[]
      bindings?: string[]
    },
    branchId?: string | null,
  ) => api.post<Variable>(withBranch(`/projects/${slug}/variables`, branchId), data),
  update: (
    slug: string,
    id: string,
    data: {
      name?: string
      variable_type?: VariableType
      description?: string
      allowed_values?: string[]
      bindings?: string[]
      excluded_from_scans?: boolean
    },
    branchId?: string | null,
  ) => api.patch<Variable>(withBranch(`/projects/${slug}/variables/${id}`, branchId), data),
  values: (slug: string, id: string, branchId?: string | null) =>
    api.get<VariableValueContext[]>(
      withBranch(`/projects/${slug}/variables/${id}/values`, branchId),
    ),
  del: (slug: string, id: string, branchId?: string | null) =>
    api.del(withBranch(`/projects/${slug}/variables/${id}`, branchId)),
  bulkUpdate: (
    slug: string,
    data: {
      variable_ids: string[]
      variable_type?: VariableType
      description?: string
      allowed_values_add?: string[]
      allowed_values_remove?: string[]
    },
    branchId?: string | null,
  ) => api.post<void>(withBranch(`/projects/${slug}/variables/bulk-update`, branchId), data),
  bulkDelete: (slug: string, variableIds: string[], branchId?: string | null) =>
    api.post<void>(withBranch(`/projects/${slug}/variables/bulk-delete`, branchId), {
      variable_ids: variableIds,
    }),
}
