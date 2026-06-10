export type ServiceSettingsSectionKey =
  | 'runtime'
  | 'ai'
  | 'email'
  | 'security'
  | 'storage'
  | 'observability'
  | 'system'

export const SERVICE_SETTINGS_TABS: { value: ServiceSettingsSectionKey; label: string }[] = [
  { value: 'runtime', label: 'Runtime' },
  { value: 'ai', label: 'AI' },
  { value: 'email', label: 'Email' },
  { value: 'security', label: 'Security' },
  { value: 'storage', label: 'Storage' },
  { value: 'observability', label: 'Observability' },
  { value: 'system', label: 'System' },
]
