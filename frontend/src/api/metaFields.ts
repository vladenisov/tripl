import { api } from './client'
import type { MetaFieldDefinition, Sensitivity } from '../types'

export const metaFieldsApi = {
  list: (slug: string) => api.get<MetaFieldDefinition[]>(`/projects/${slug}/meta-fields`),
  create: (slug: string, data: {
    name: string; display_name: string; field_type: string; is_required?: boolean;
    enum_options?: string[]; default_value?: string; link_template?: string | null;
    sensitivity?: Sensitivity
  }) => api.post<MetaFieldDefinition>(`/projects/${slug}/meta-fields`, data),
  update: (slug: string, id: string, data: Partial<MetaFieldDefinition>) =>
    api.patch<MetaFieldDefinition>(`/projects/${slug}/meta-fields/${id}`, data),
  del: (slug: string, id: string) => api.del(`/projects/${slug}/meta-fields/${id}`),
}
