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
  // Omitting the recipient mails the signed-in owner — the address they are
  // most likely to be able to check, and one fewer field before the first probe.
  testEmail: (recipient?: string) =>
    api.post<SettingsTestResponse>('/settings/email/test', recipient ? { recipient } : {}),
}
