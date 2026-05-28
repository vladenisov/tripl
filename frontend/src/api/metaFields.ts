import { api, withBranch } from './client'
import type { MetaFieldDefinition, Sensitivity } from '../types'

export const metaFieldsApi = {
  list: (slug: string, branchId?: string | null) =>
    api.get<MetaFieldDefinition[]>(withBranch(`/projects/${slug}/meta-fields`, branchId)),
  create: (
    slug: string,
    data: {
      name: string
      display_name: string
      field_type: string
      is_required?: boolean
      enum_options?: string[]
      default_value?: string
      link_template?: string | null
      sensitivity?: Sensitivity
    },
    branchId?: string | null,
  ) =>
    api.post<MetaFieldDefinition>(
      withBranch(`/projects/${slug}/meta-fields`, branchId),
      data,
    ),
  update: (
    slug: string,
    id: string,
    data: Partial<MetaFieldDefinition>,
    branchId?: string | null,
  ) =>
    api.patch<MetaFieldDefinition>(
      withBranch(`/projects/${slug}/meta-fields/${id}`, branchId),
      data,
    ),
  del: (slug: string, id: string, branchId?: string | null) =>
    api.del(withBranch(`/projects/${slug}/meta-fields/${id}`, branchId)),
}
