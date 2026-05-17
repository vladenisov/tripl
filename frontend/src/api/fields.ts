import { api } from './client'
import type { FieldDefinition, Sensitivity } from '../types'

export const fieldsApi = {
  list: (slug: string, etId: string) =>
    api.get<FieldDefinition[]>(`/projects/${slug}/event-types/${etId}/fields`),
  create: (slug: string, etId: string, data: {
    name: string; display_name: string; field_type: string; is_required?: boolean;
    enum_options?: string[]; description?: string; order?: number; sensitivity?: Sensitivity
  }) => api.post<FieldDefinition>(`/projects/${slug}/event-types/${etId}/fields`, data),
  update: (slug: string, etId: string, fieldId: string, data: Partial<FieldDefinition>) =>
    api.patch<FieldDefinition>(`/projects/${slug}/event-types/${etId}/fields/${fieldId}`, data),
  del: (slug: string, etId: string, fieldId: string) =>
    api.del(`/projects/${slug}/event-types/${etId}/fields/${fieldId}`),
  reorder: (slug: string, etId: string, fieldIds: string[]) =>
    api.patch<FieldDefinition[]>(`/projects/${slug}/event-types/${etId}/fields/reorder`, { field_ids: fieldIds }),
}
