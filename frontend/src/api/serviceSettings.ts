import { api } from './client'
import type { components } from '@/types/api.gen'
import type {
  ServiceSettings,
  ServiceSettingsUpdate,
  SettingsTestResponse,
} from '@/types'

/** The built-in AI system prompts, for "Restore default" (ST-30). */
export type AiPromptDefaults = components['schemas']['AiPromptDefaultsResponse']

/** The instance row caps a scan falls back to, readable by any signed-in user. */
export type RowLimitDefaults = components['schemas']['RowLimitDefaultsResponse']

export const serviceSettingsApi = {
  get: () => api.get<ServiceSettings>('/settings'),
  aiPromptDefaults: () => api.get<AiPromptDefaults>('/settings/ai/defaults'),
  rowLimitDefaults: () => api.get<RowLimitDefaults>('/settings/row-limits'),
  update: (data: ServiceSettingsUpdate) => api.patch<ServiceSettings>('/settings', data),
  testAi: (prompt?: string) =>
    api.post<SettingsTestResponse>('/settings/ai/test', prompt ? { prompt } : {}),
  // Omitting the recipient mails the signed-in owner — the address they are
  // most likely to be able to check, and one fewer field before the first probe.
  testEmail: (recipient?: string) =>
    api.post<SettingsTestResponse>('/settings/email/test', recipient ? { recipient } : {}),
}
