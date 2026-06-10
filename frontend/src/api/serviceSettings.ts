import { api } from './client'
import type {
  AiSettingsResponse,
  AiSettingsUpdate,
  ServiceSettings,
  ServiceSettingsUpdate,
  SettingsTestResponse,
} from '@/types'

export const serviceSettingsApi = {
  get: () => api.get<ServiceSettings>('/settings'),
  update: (data: ServiceSettingsUpdate) => api.patch<ServiceSettings>('/settings', data),
  updateAi: (data: AiSettingsUpdate) => api.put<AiSettingsResponse>('/settings/ai', data),
  testAi: (prompt?: string) =>
    api.post<SettingsTestResponse>('/settings/ai/test', prompt ? { prompt } : {}),
}
