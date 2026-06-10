import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  Bot,
  CheckCircle2,
  HardDrive,
  KeyRound,
  Mail,
  RotateCcw,
  Save,
  ServerCog,
  Shield,
  SlidersHorizontal,
  XCircle,
} from 'lucide-react'

import { serviceSettingsApi } from '@/api/serviceSettings'
import { useAuth } from '@/components/auth-context'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { getErrorMessage } from '@/lib/utils'
import type {
  AiServiceSettings,
  EmailSettings,
  ObservabilitySettings,
  RuntimeSettings,
  SecuritySettings,
  ServiceSettings,
  ServiceSettingsUpdate,
  SettingSource,
  StorageSettings,
  SystemSettings,
} from '@/types'

type SectionKey = 'runtime' | 'ai' | 'email' | 'security' | 'storage' | 'observability'

type EditableSettings = {
  runtime: RuntimeSettings
  ai: AiServiceSettings
  email: EmailSettings
  security: SecuritySettings
  storage: StorageSettings
  observability: ObservabilitySettings
}

type SecretDrafts = {
  ai_api_key: string
  search_embedding_api_key: string
  smtp_password: string
}

const EMPTY_SECRET_DRAFTS: SecretDrafts = {
  ai_api_key: '',
  search_embedding_api_key: '',
  smtp_password: '',
}

const RESET_FIELDS: Record<SectionKey, readonly string[]> = {
  runtime: ['app_base_url', 'scan_row_limit_default', 'metrics_row_limit_default'],
  ai: [
    'ai_enabled',
    'ai_base_url',
    'ai_model',
    'ai_api_key',
    'ai_timeout_seconds',
    'ai_max_output_tokens',
    'describe_system_prompt',
    'ask_system_prompt',
    'alert_explanation_system_prompt',
    'search_embeddings_enabled',
    'search_embedding_provider',
    'search_embedding_model',
    'search_embedding_api_key',
  ],
  email: [
    'smtp_host',
    'smtp_port',
    'smtp_username',
    'smtp_password',
    'smtp_use_tls',
    'smtp_from_address',
  ],
  security: [
    'cors_allow_origins',
    'session_cookie_name',
    'session_ttl_hours',
    'session_cookie_secure',
    'security_headers_enabled',
    'hsts_enabled',
    'hsts_max_age_seconds',
    'content_security_policy',
    'rate_limit_enabled',
    'rate_limit_login_per_minute',
    'rate_limit_register_per_hour',
    'rate_limit_trust_forwarded_for',
  ],
  storage: [
    'photo_storage_backend',
    'photo_local_dir',
    'photo_max_size_mb',
    'photo_allowed_mime',
    'gcs_photo_bucket',
    'gcs_photo_credentials_path',
    'gcs_photo_public',
    'gcs_photo_signed_url_ttl_seconds',
  ],
  observability: [
    'request_id_header',
    'log_level',
    'log_json',
    'prometheus_metrics_enabled',
    'otel_exporter_otlp_endpoint',
    'otel_service_name',
  ],
}

const COMPARE_FIELDS: Record<SectionKey, readonly string[]> = {
  ...RESET_FIELDS,
  ai: RESET_FIELDS.ai.filter(
    field => field !== 'ai_api_key' && field !== 'search_embedding_api_key',
  ),
  email: RESET_FIELDS.email.filter(field => field !== 'smtp_password'),
}

function editableFromSettings(settings: ServiceSettings): EditableSettings {
  return {
    runtime: { ...settings.runtime },
    ai: { ...settings.ai },
    email: { ...settings.email },
    security: { ...settings.security },
    storage: { ...settings.storage },
    observability: { ...settings.observability },
  }
}

function sourceFor(
  settings: ServiceSettings | undefined,
  section: SectionKey,
  field: string,
): SettingSource {
  return settings?.sources[`${section}.${field}`] ?? 'env'
}

function buildSectionDiff(
  section: SectionKey,
  fields: readonly string[],
  current: EditableSettings,
  saved: ServiceSettings,
): Record<string, string | number | boolean> {
  const changes: Record<string, string | number | boolean> = {}
  const currentSection = current[section] as Record<string, string | number | boolean>
  const savedSection = saved[section] as Record<string, string | number | boolean>
  for (const field of fields) {
    if (currentSection[field] !== savedSection[field]) {
      changes[field] = currentSection[field]
    }
  }
  return changes
}

function buildUpdate(
  form: EditableSettings | null,
  saved: ServiceSettings | undefined,
  secretDrafts: SecretDrafts,
): ServiceSettingsUpdate {
  if (!form || !saved) return {}
  const update: ServiceSettingsUpdate = {}

  for (const section of Object.keys(COMPARE_FIELDS) as SectionKey[]) {
    const diff = buildSectionDiff(section, COMPARE_FIELDS[section], form, saved)
    if (Object.keys(diff).length > 0) {
      update[section] = diff as never
    }
  }

  if (secretDrafts.ai_api_key.trim()) {
    update.ai = { ...(update.ai ?? {}), ai_api_key: secretDrafts.ai_api_key.trim() }
  }
  if (secretDrafts.search_embedding_api_key.trim()) {
    update.ai = {
      ...(update.ai ?? {}),
      search_embedding_api_key: secretDrafts.search_embedding_api_key.trim(),
    }
  }
  if (secretDrafts.smtp_password.trim()) {
    update.email = {
      ...(update.email ?? {}),
      smtp_password: secretDrafts.smtp_password,
    }
  }

  return update
}

function hasUpdate(update: ServiceSettingsUpdate) {
  return Object.values(update).some(section => section && Object.keys(section).length > 0)
}

function resetPayload(section: SectionKey): ServiceSettingsUpdate {
  return {
    [section]: Object.fromEntries(RESET_FIELDS[section].map(field => [field, null])),
  } as ServiceSettingsUpdate
}

function SourceBadge({ source }: { source: SettingSource }) {
  return (
    <Badge variant={source === 'override' ? 'info' : 'outline'} className="text-[10px]">
      {source === 'override' ? 'Override' : 'Env'}
    </Badge>
  )
}

function StatusBadge({ active, label }: { active: boolean; label: string }) {
  return (
    <span
      className={
        active
          ? 'inline-flex items-center gap-1 text-xs text-emerald-600'
          : 'inline-flex items-center gap-1 text-xs text-muted-foreground'
      }
    >
      {active ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
      {label}
    </span>
  )
}

function SectionCard({
  title,
  icon: Icon,
  children,
  onReset,
  resetting,
}: {
  title: string
  icon: ComponentType<{ className?: string }>
  children: ReactNode
  onReset?: () => void
  resetting?: boolean
}) {
  return (
    <Card>
      <CardContent className="p-0">
        <div
          className="flex items-center gap-2 border-b px-4 py-3"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <Icon className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{title}</h2>
          <div className="flex-1" />
          {onReset && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onReset}
              disabled={resetting}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Reset
            </Button>
          )}
        </div>
        <div className="grid gap-4 p-4">{children}</div>
      </CardContent>
    </Card>
  )
}

function FieldRow({
  label,
  source,
  children,
}: {
  label: string
  source?: SettingSource
  children: ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex min-w-0 items-center gap-2">
        <Label className="text-xs">{label}</Label>
        {source && <SourceBadge source={source} />}
      </div>
      {children}
    </div>
  )
}

export default function ServiceSettingsPage() {
  const { user } = useAuth()
  const qc = useQueryClient()
  const [form, setForm] = useState<EditableSettings | null>(null)
  const [secretDrafts, setSecretDrafts] = useState<SecretDrafts>(EMPTY_SECRET_DRAFTS)

  const settingsQuery = useQuery({
    queryKey: ['serviceSettings'],
    queryFn: serviceSettingsApi.get,
    enabled: user?.role === 'owner',
  })

  useEffect(() => {
    if (settingsQuery.data) {
      setForm(editableFromSettings(settingsQuery.data))
      setSecretDrafts(EMPTY_SECRET_DRAFTS)
    }
  }, [settingsQuery.data])

  const saveMut = useMutation({
    mutationFn: (data: ServiceSettingsUpdate) => serviceSettingsApi.update(data),
    onSuccess: data => {
      qc.setQueryData(['serviceSettings'], data)
      setForm(editableFromSettings(data))
      setSecretDrafts(EMPTY_SECRET_DRAFTS)
    },
  })

  const aiTestMut = useMutation({
    mutationFn: () => serviceSettingsApi.testAi(),
  })

  const update = useMemo(
    () => buildUpdate(form, settingsQuery.data, secretDrafts),
    [form, settingsQuery.data, secretDrafts],
  )
  const dirty = hasUpdate(update)

  const setField = (section: SectionKey, field: string, value: string | number | boolean) => {
    setForm(current => {
      if (!current) return current
      return {
        ...current,
        [section]: {
          ...current[section],
          [field]: value,
        },
      } as EditableSettings
    })
  }

  const resetSection = (section: SectionKey) => {
    saveMut.mutate(resetPayload(section))
  }

  const clearSecret = (section: 'ai' | 'email', field: string) => {
    saveMut.mutate({ [section]: { [field]: null } } as ServiceSettingsUpdate)
  }

  if (user?.role !== 'owner') {
    return (
      <div className="max-w-3xl">
        <Card>
          <CardContent className="p-5">
            <h1 className="text-xl font-semibold">Service settings</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Owner role is required to view or change instance-level settings.
            </p>
          </CardContent>
        </Card>
      </div>
    )
  }

  if (settingsQuery.isLoading || !settingsQuery.data || !form) {
    return <div className="text-sm text-muted-foreground">Loading service settings...</div>
  }

  if (settingsQuery.isError) {
    return (
      <div className="text-sm text-destructive">
        {getErrorMessage(settingsQuery.error)}
      </div>
    )
  }

  const settings = settingsQuery.data

  return (
    <div className="min-w-0 space-y-5">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <SlidersHorizontal className="h-5 w-5" />
            Service settings
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Runtime overrides for the tripl instance. Unset fields fall back to environment
            variables.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {saveMut.isError && (
            <span className="text-xs text-destructive">{getErrorMessage(saveMut.error)}</span>
          )}
          <Button
            type="button"
            onClick={() => saveMut.mutate(update)}
            disabled={!dirty || saveMut.isPending}
          >
            <Save className="h-3.5 w-3.5" />
            {saveMut.isPending ? 'Saving...' : 'Save changes'}
          </Button>
        </div>
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <SectionCard
          title="Runtime"
          icon={ServerCog}
          onReset={() => resetSection('runtime')}
          resetting={saveMut.isPending}
        >
          <FieldRow
            label="App base URL"
            source={sourceFor(settings, 'runtime', 'app_base_url')}
          >
            <Input
              value={form.runtime.app_base_url}
              onChange={event => setField('runtime', 'app_base_url', event.target.value)}
              placeholder="https://tripl.example.com"
            />
          </FieldRow>
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldRow
              label="Scan row limit default"
              source={sourceFor(settings, 'runtime', 'scan_row_limit_default')}
            >
              <Input
                type="number"
                min={1}
                value={form.runtime.scan_row_limit_default}
                onChange={event =>
                  setField('runtime', 'scan_row_limit_default', Number(event.target.value))
                }
              />
            </FieldRow>
            <FieldRow
              label="Metrics row limit default"
              source={sourceFor(settings, 'runtime', 'metrics_row_limit_default')}
            >
              <Input
                type="number"
                min={1}
                value={form.runtime.metrics_row_limit_default}
                onChange={event =>
                  setField('runtime', 'metrics_row_limit_default', Number(event.target.value))
                }
              />
            </FieldRow>
          </div>
        </SectionCard>

        <SectionCard
          title="Email"
          icon={Mail}
          onReset={() => resetSection('email')}
          resetting={saveMut.isPending}
        >
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_120px]">
            <FieldRow label="SMTP host" source={sourceFor(settings, 'email', 'smtp_host')}>
              <Input
                value={form.email.smtp_host}
                onChange={event => setField('email', 'smtp_host', event.target.value)}
              />
            </FieldRow>
            <FieldRow label="Port" source={sourceFor(settings, 'email', 'smtp_port')}>
              <Input
                type="number"
                min={1}
                max={65535}
                value={form.email.smtp_port}
                onChange={event => setField('email', 'smtp_port', Number(event.target.value))}
              />
            </FieldRow>
          </div>
          <FieldRow label="SMTP username" source={sourceFor(settings, 'email', 'smtp_username')}>
            <Input
              value={form.email.smtp_username}
              onChange={event => setField('email', 'smtp_username', event.target.value)}
            />
          </FieldRow>
          <FieldRow label="SMTP password" source={sourceFor(settings, 'email', 'smtp_password')}>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="password"
                value={secretDrafts.smtp_password}
                onChange={event =>
                  setSecretDrafts(current => ({
                    ...current,
                    smtp_password: event.target.value,
                  }))
                }
                placeholder={
                  form.email.smtp_password_configured
                    ? 'Configured - leave blank to keep'
                    : 'Not configured'
                }
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => clearSecret('email', 'smtp_password')}
                disabled={saveMut.isPending}
              >
                Clear
              </Button>
            </div>
          </FieldRow>
          <div className="grid gap-4 sm:grid-cols-2">
            <SwitchRow
              label="Use TLS"
              source={sourceFor(settings, 'email', 'smtp_use_tls')}
              checked={form.email.smtp_use_tls}
              onChange={value => setField('email', 'smtp_use_tls', value)}
            />
            <FieldRow
              label="Default From address"
              source={sourceFor(settings, 'email', 'smtp_from_address')}
            >
              <Input
                value={form.email.smtp_from_address}
                onChange={event => setField('email', 'smtp_from_address', event.target.value)}
              />
            </FieldRow>
          </div>
        </SectionCard>

        <SectionCard
          title="AI and embeddings"
          icon={Bot}
          onReset={() => resetSection('ai')}
          resetting={saveMut.isPending}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <SwitchRow
              label="AI enabled"
              source={sourceFor(settings, 'ai', 'ai_enabled')}
              checked={form.ai.ai_enabled}
              onChange={value => setField('ai', 'ai_enabled', value)}
            />
            <div className="flex items-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => aiTestMut.mutate()}
                disabled={aiTestMut.isPending}
              >
                <KeyRound className="h-3.5 w-3.5" />
                {aiTestMut.isPending ? 'Testing...' : 'Test AI'}
              </Button>
              {aiTestMut.data && (
                <StatusBadge active={aiTestMut.data.ok} label={aiTestMut.data.message} />
              )}
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <FieldRow label="Base URL" source={sourceFor(settings, 'ai', 'ai_base_url')}>
              <Input
                value={form.ai.ai_base_url}
                onChange={event => setField('ai', 'ai_base_url', event.target.value)}
              />
            </FieldRow>
            <FieldRow label="Model" source={sourceFor(settings, 'ai', 'ai_model')}>
              <Input
                value={form.ai.ai_model}
                onChange={event => setField('ai', 'ai_model', event.target.value)}
              />
            </FieldRow>
          </div>
          <FieldRow label="AI API key" source={sourceFor(settings, 'ai', 'ai_api_key')}>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="password"
                value={secretDrafts.ai_api_key}
                onChange={event =>
                  setSecretDrafts(current => ({
                    ...current,
                    ai_api_key: event.target.value,
                  }))
                }
                placeholder={
                  form.ai.ai_api_key_configured
                    ? 'Configured - leave blank to keep'
                    : 'Not configured'
                }
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => clearSecret('ai', 'ai_api_key')}
                disabled={saveMut.isPending}
              >
                Clear
              </Button>
            </div>
          </FieldRow>
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldRow label="Timeout seconds" source={sourceFor(settings, 'ai', 'ai_timeout_seconds')}>
              <Input
                type="number"
                min={1}
                value={form.ai.ai_timeout_seconds}
                onChange={event => setField('ai', 'ai_timeout_seconds', Number(event.target.value))}
              />
            </FieldRow>
            <FieldRow label="Max output tokens" source={sourceFor(settings, 'ai', 'ai_max_output_tokens')}>
              <Input
                type="number"
                min={1}
                value={form.ai.ai_max_output_tokens}
                onChange={event => setField('ai', 'ai_max_output_tokens', Number(event.target.value))}
              />
            </FieldRow>
          </div>
          <div className="grid gap-4">
            <PromptField
              label="Describe prompt"
              source={sourceFor(settings, 'ai', 'describe_system_prompt')}
              value={form.ai.describe_system_prompt}
              onChange={value => setField('ai', 'describe_system_prompt', value)}
            />
            <PromptField
              label="Ask prompt"
              source={sourceFor(settings, 'ai', 'ask_system_prompt')}
              value={form.ai.ask_system_prompt}
              onChange={value => setField('ai', 'ask_system_prompt', value)}
            />
            <PromptField
              label="Alert explanation prompt"
              source={sourceFor(settings, 'ai', 'alert_explanation_system_prompt')}
              value={form.ai.alert_explanation_system_prompt}
              onChange={value => setField('ai', 'alert_explanation_system_prompt', value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <SwitchRow
              label="Search embeddings"
              source={sourceFor(settings, 'ai', 'search_embeddings_enabled')}
              checked={form.ai.search_embeddings_enabled}
              onChange={value => setField('ai', 'search_embeddings_enabled', value)}
            />
            <FieldRow label="Embedding dimensions">
              <Input value={form.ai.search_embedding_dimensions} disabled readOnly />
            </FieldRow>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldRow
              label="Embedding provider"
              source={sourceFor(settings, 'ai', 'search_embedding_provider')}
            >
              <Input
                value={form.ai.search_embedding_provider}
                onChange={event =>
                  setField('ai', 'search_embedding_provider', event.target.value)
                }
              />
            </FieldRow>
            <FieldRow
              label="Embedding model"
              source={sourceFor(settings, 'ai', 'search_embedding_model')}
            >
              <Input
                value={form.ai.search_embedding_model}
                onChange={event =>
                  setField('ai', 'search_embedding_model', event.target.value)
                }
              />
            </FieldRow>
          </div>
          <FieldRow
            label="Embedding API key"
            source={sourceFor(settings, 'ai', 'search_embedding_api_key')}
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                type="password"
                value={secretDrafts.search_embedding_api_key}
                onChange={event =>
                  setSecretDrafts(current => ({
                    ...current,
                    search_embedding_api_key: event.target.value,
                  }))
                }
                placeholder={
                  form.ai.search_embedding_api_key_configured
                    ? 'Configured - leave blank to keep'
                    : 'Not configured'
                }
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => clearSecret('ai', 'search_embedding_api_key')}
                disabled={saveMut.isPending}
              >
                Clear
              </Button>
            </div>
          </FieldRow>
        </SectionCard>

        <SectionCard
          title="Security"
          icon={Shield}
          onReset={() => resetSection('security')}
          resetting={saveMut.isPending}
        >
          <FieldRow
            label="CORS allow origins"
            source={sourceFor(settings, 'security', 'cors_allow_origins')}
          >
            <Input
              value={form.security.cors_allow_origins}
              onChange={event => setField('security', 'cors_allow_origins', event.target.value)}
              placeholder="https://app.example.com,https://admin.example.com"
            />
          </FieldRow>
          <div className="grid gap-4 sm:grid-cols-3">
            <FieldRow
              label="Session cookie"
              source={sourceFor(settings, 'security', 'session_cookie_name')}
            >
              <Input
                value={form.security.session_cookie_name}
                onChange={event =>
                  setField('security', 'session_cookie_name', event.target.value)
                }
              />
            </FieldRow>
            <FieldRow
              label="Session TTL hours"
              source={sourceFor(settings, 'security', 'session_ttl_hours')}
            >
              <Input
                type="number"
                min={1}
                value={form.security.session_ttl_hours}
                onChange={event =>
                  setField('security', 'session_ttl_hours', Number(event.target.value))
                }
              />
            </FieldRow>
            <SwitchRow
              label="Secure cookie"
              source={sourceFor(settings, 'security', 'session_cookie_secure')}
              checked={form.security.session_cookie_secure}
              onChange={value => setField('security', 'session_cookie_secure', value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <SwitchRow
              label="Security headers"
              source={sourceFor(settings, 'security', 'security_headers_enabled')}
              checked={form.security.security_headers_enabled}
              onChange={value => setField('security', 'security_headers_enabled', value)}
            />
            <SwitchRow
              label="HSTS"
              source={sourceFor(settings, 'security', 'hsts_enabled')}
              checked={form.security.hsts_enabled}
              onChange={value => setField('security', 'hsts_enabled', value)}
            />
            <FieldRow
              label="HSTS max age"
              source={sourceFor(settings, 'security', 'hsts_max_age_seconds')}
            >
              <Input
                type="number"
                min={0}
                value={form.security.hsts_max_age_seconds}
                onChange={event =>
                  setField('security', 'hsts_max_age_seconds', Number(event.target.value))
                }
              />
            </FieldRow>
          </div>
          <PromptField
            label="Content Security Policy"
            source={sourceFor(settings, 'security', 'content_security_policy')}
            value={form.security.content_security_policy}
            onChange={value => setField('security', 'content_security_policy', value)}
          />
          <div className="grid gap-4 sm:grid-cols-4">
            <SwitchRow
              label="Rate limiting"
              source={sourceFor(settings, 'security', 'rate_limit_enabled')}
              checked={form.security.rate_limit_enabled}
              onChange={value => setField('security', 'rate_limit_enabled', value)}
            />
            <FieldRow
              label="Login/min"
              source={sourceFor(settings, 'security', 'rate_limit_login_per_minute')}
            >
              <Input
                type="number"
                min={0}
                value={form.security.rate_limit_login_per_minute}
                onChange={event =>
                  setField('security', 'rate_limit_login_per_minute', Number(event.target.value))
                }
              />
            </FieldRow>
            <FieldRow
              label="Register/hour"
              source={sourceFor(settings, 'security', 'rate_limit_register_per_hour')}
            >
              <Input
                type="number"
                min={0}
                value={form.security.rate_limit_register_per_hour}
                onChange={event =>
                  setField('security', 'rate_limit_register_per_hour', Number(event.target.value))
                }
              />
            </FieldRow>
            <SwitchRow
              label="Trust XFF"
              source={sourceFor(settings, 'security', 'rate_limit_trust_forwarded_for')}
              checked={form.security.rate_limit_trust_forwarded_for}
              onChange={value =>
                setField('security', 'rate_limit_trust_forwarded_for', value)
              }
            />
          </div>
        </SectionCard>

        <SectionCard
          title="Storage"
          icon={HardDrive}
          onReset={() => resetSection('storage')}
          resetting={saveMut.isPending}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldRow
              label="Photo storage backend"
              source={sourceFor(settings, 'storage', 'photo_storage_backend')}
            >
              <Input
                value={form.storage.photo_storage_backend}
                onChange={event =>
                  setField('storage', 'photo_storage_backend', event.target.value)
                }
              />
            </FieldRow>
            <FieldRow
              label="Photo max size MB"
              source={sourceFor(settings, 'storage', 'photo_max_size_mb')}
            >
              <Input
                type="number"
                min={1}
                value={form.storage.photo_max_size_mb}
                onChange={event =>
                  setField('storage', 'photo_max_size_mb', Number(event.target.value))
                }
              />
            </FieldRow>
          </div>
          <FieldRow label="Local photo directory" source={sourceFor(settings, 'storage', 'photo_local_dir')}>
            <Input
              value={form.storage.photo_local_dir}
              onChange={event => setField('storage', 'photo_local_dir', event.target.value)}
            />
          </FieldRow>
          <FieldRow
            label="Allowed MIME types"
            source={sourceFor(settings, 'storage', 'photo_allowed_mime')}
          >
            <Input
              value={form.storage.photo_allowed_mime}
              onChange={event => setField('storage', 'photo_allowed_mime', event.target.value)}
            />
          </FieldRow>
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldRow label="GCS bucket" source={sourceFor(settings, 'storage', 'gcs_photo_bucket')}>
              <Input
                value={form.storage.gcs_photo_bucket}
                onChange={event => setField('storage', 'gcs_photo_bucket', event.target.value)}
              />
            </FieldRow>
            <SwitchRow
              label="GCS public URLs"
              source={sourceFor(settings, 'storage', 'gcs_photo_public')}
              checked={form.storage.gcs_photo_public}
              onChange={value => setField('storage', 'gcs_photo_public', value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
            <FieldRow
              label="GCS credentials path"
              source={sourceFor(settings, 'storage', 'gcs_photo_credentials_path')}
            >
              <Input
                value={form.storage.gcs_photo_credentials_path}
                onChange={event =>
                  setField('storage', 'gcs_photo_credentials_path', event.target.value)
                }
              />
            </FieldRow>
            <FieldRow
              label="Signed URL TTL"
              source={sourceFor(settings, 'storage', 'gcs_photo_signed_url_ttl_seconds')}
            >
              <Input
                type="number"
                min={1}
                value={form.storage.gcs_photo_signed_url_ttl_seconds}
                onChange={event =>
                  setField(
                    'storage',
                    'gcs_photo_signed_url_ttl_seconds',
                    Number(event.target.value),
                  )
                }
              />
            </FieldRow>
          </div>
        </SectionCard>

        <SectionCard
          title="Observability"
          icon={Activity}
          onReset={() => resetSection('observability')}
          resetting={saveMut.isPending}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldRow
              label="Request ID header"
              source={sourceFor(settings, 'observability', 'request_id_header')}
            >
              <Input
                value={form.observability.request_id_header}
                onChange={event =>
                  setField('observability', 'request_id_header', event.target.value)
                }
              />
            </FieldRow>
            <FieldRow label="Log level" source={sourceFor(settings, 'observability', 'log_level')}>
              <Input
                value={form.observability.log_level}
                onChange={event => setField('observability', 'log_level', event.target.value)}
              />
            </FieldRow>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <SwitchRow
              label="JSON logs"
              source={sourceFor(settings, 'observability', 'log_json')}
              checked={form.observability.log_json}
              onChange={value => setField('observability', 'log_json', value)}
            />
            <SwitchRow
              label="Prometheus metrics"
              source={sourceFor(settings, 'observability', 'prometheus_metrics_enabled')}
              checked={form.observability.prometheus_metrics_enabled}
              onChange={value => setField('observability', 'prometheus_metrics_enabled', value)}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldRow
              label="OTLP endpoint"
              source={sourceFor(settings, 'observability', 'otel_exporter_otlp_endpoint')}
            >
              <Input
                value={form.observability.otel_exporter_otlp_endpoint}
                onChange={event =>
                  setField('observability', 'otel_exporter_otlp_endpoint', event.target.value)
                }
              />
            </FieldRow>
            <FieldRow
              label="OTEL service name"
              source={sourceFor(settings, 'observability', 'otel_service_name')}
            >
              <Input
                value={form.observability.otel_service_name}
                onChange={event =>
                  setField('observability', 'otel_service_name', event.target.value)
                }
              />
            </FieldRow>
          </div>
        </SectionCard>

        <SystemCard system={settings.system} />
      </div>
    </div>
  )
}

function SwitchRow({
  label,
  source,
  checked,
  onChange,
}: {
  label: string
  source?: SettingSource
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <FieldRow label={label} source={source}>
      <div className="flex h-10 items-center">
        <Switch checked={checked} onCheckedChange={onChange} />
      </div>
    </FieldRow>
  )
}

function PromptField({
  label,
  source,
  value,
  onChange,
}: {
  label: string
  source?: SettingSource
  value: string
  onChange: (value: string) => void
}) {
  return (
    <FieldRow label={label} source={source}>
      <Textarea
        value={value}
        onChange={event => onChange(event.target.value)}
        rows={4}
        className="min-h-24 font-mono text-xs leading-relaxed"
      />
    </FieldRow>
  )
}

function SystemCard({ system }: { system: SystemSettings }) {
  const rows: { label: string; active: boolean }[] = [
    { label: 'Debug mode', active: system.debug },
    { label: 'Database URL', active: system.database_url_configured },
    { label: 'Sync database URL', active: system.sync_database_url_configured },
    { label: 'RabbitMQ URL', active: system.rabbitmq_url_configured },
    { label: 'Redis URL', active: system.redis_url_configured },
    { label: 'Encryption key', active: system.encryption_key_configured },
    { label: 'OpenAI fallback key', active: system.openai_api_key_configured },
  ]

  return (
    <SectionCard title="System" icon={ServerCog}>
      <div className="grid gap-3 sm:grid-cols-2">
        {rows.map(row => (
          <div
            key={row.label}
            className="flex min-h-10 items-center justify-between gap-3 rounded-md border px-3"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            <span className="text-xs text-muted-foreground">{row.label}</span>
            <StatusBadge active={row.active} label={row.active ? 'Configured' : 'Unset'} />
          </div>
        ))}
      </div>
    </SectionCard>
  )
}
