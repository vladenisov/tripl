import { api, withBranch } from './client'
import type { FieldDefinition, Sensitivity } from '../types'

export const fieldsApi = {
  list: (slug: string, etId: string, branchId?: string | null) =>
    api.get<FieldDefinition[]>(withBranch(`/projects/${slug}/event-types/${etId}/fields`, branchId)),
  create: (
    slug: string,
    etId: string,
    data: {
      name: string
      display_name: string
      field_type: string
      is_required?: boolean
      enum_options?: string[]
      description?: string
      order?: number
      sensitivity?: Sensitivity
    },
    branchId?: string | null,
  ) =>
    api.post<FieldDefinition>(
      withBranch(`/projects/${slug}/event-types/${etId}/fields`, branchId),
      data,
    ),
  bulkCreate: (
    slug: string,
    etId: string,
    fields: Array<{
      name: string
      display_name: string
      field_type: string
      is_required?: boolean
      sensitivity?: Sensitivity
    }>,
    branchId?: string | null,
  ) =>
    api.post<FieldDefinition[]>(
      withBranch(`/projects/${slug}/event-types/${etId}/fields/bulk`, branchId),
      { fields },
    ),
  update: (
    slug: string,
    etId: string,
    fieldId: string,
    data: Partial<FieldDefinition>,
    branchId?: string | null,
  ) =>
    api.patch<FieldDefinition>(
      withBranch(`/projects/${slug}/event-types/${etId}/fields/${fieldId}`, branchId),
      data,
    ),
  del: (slug: string, etId: string, fieldId: string, branchId?: string | null) =>
    api.del(withBranch(`/projects/${slug}/event-types/${etId}/fields/${fieldId}`, branchId)),
  reorder: (slug: string, etId: string, fieldIds: string[], branchId?: string | null) =>
    api.patch<FieldDefinition[]>(
      withBranch(`/projects/${slug}/event-types/${etId}/fields/reorder`, branchId),
      { field_ids: fieldIds },
    ),
}
