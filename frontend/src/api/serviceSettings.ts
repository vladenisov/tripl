import { api } from './client'
import type {
  ServiceSettings,
  ServiceSettingsUpdate,
  SettingsTestResponse,
} from '@/types'

export const serviceSettingsApi = {
  get: () => api.get<ServiceSettings>('/settings'),
  update: (data: ServiceSettingsUpdate) => api.patch<ServiceSettings>('/settings', data),
  testAi: (prompt?: string) =>
    api.post<SettingsTestResponse>('/settings/ai/test', prompt ? { prompt } : {}),
  // Omitting the recipient mails the signed-in owner — the address they are
  // most likely to be able to check, and one fewer field before the first probe.
  testEmail: (recipient?: string) =>
    api.post<SettingsTestResponse>('/settings/email/test', recipient ? { recipient } : {}),
}
