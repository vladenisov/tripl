import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Save } from 'lucide-react'

import { serviceSettingsApi } from '@/api/serviceSettings'
import type { ServiceSettingsSectionKey } from './serviceSettingsTabs'
import { useAuth } from '@/components/auth-context'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { getErrorMessage } from '@/lib/utils'
import type { ServiceSettings, ServiceSettingsUpdate } from '@/types'

import { AiSection } from './settings-service/AiSection'
import { EmailSection } from './settings-service/EmailSection'
import { ObservabilitySection } from './settings-service/ObservabilitySection'
import { RuntimeSection } from './settings-service/RuntimeSection'
import { SecuritySection } from './settings-service/SecuritySection'
import { StorageSection } from './settings-service/StorageSection'
import { SystemCard } from './settings-service/SystemCard'
import {
  type EditableSettings,
  type SecretDrafts,
  type SectionKey,
  EMPTY_SECRET_DRAFTS,
  buildUpdate,
  editableFromSettings,
  hasUpdate,
  resetPayload,
} from './settings-service/serviceSettingsHelpers'

export default function ServiceSettingsSection({
  section,
}: {
  section: ServiceSettingsSectionKey
}) {
  const { user } = useAuth()
  const qc = useQueryClient()
  const [form, setForm] = useState<EditableSettings | null>(null)
  const [secretDrafts, setSecretDrafts] = useState<SecretDrafts>(EMPTY_SECRET_DRAFTS)
  const [hydratedSettings, setHydratedSettings] = useState<ServiceSettings | null>(null)

  const settingsQuery = useQuery({
    queryKey: ['serviceSettings'],
    queryFn: serviceSettingsApi.get,
    enabled: user?.role === 'owner',
  })

  if (settingsQuery.data && hydratedSettings !== settingsQuery.data) {
    setHydratedSettings(settingsQuery.data)
    setForm(editableFromSettings(settingsQuery.data))
    setSecretDrafts(EMPTY_SECRET_DRAFTS)
  }

  const saveMut = useMutation({
    mutationFn: (data: ServiceSettingsUpdate) => serviceSettingsApi.update(data),
    onSuccess: data => {
      qc.setQueryData(['serviceSettings'], data)
      setHydratedSettings(data)
      setForm(editableFromSettings(data))
      setSecretDrafts(EMPTY_SECRET_DRAFTS)
    },
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
      {section !== 'system' && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            Runtime overrides for the tripl instance. Unset fields fall back to environment
            variables.
          </p>
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
      )}

      {section === 'runtime' && (
        <RuntimeSection
          form={form}
          settings={settings}
          setField={setField}
          onReset={() => resetSection('runtime')}
          resetting={saveMut.isPending}
        />
      )}

      {section === 'email' && (
        <EmailSection
          form={form}
          settings={settings}
          secretDrafts={secretDrafts}
          setField={setField}
          setSecretDrafts={setSecretDrafts}
          onReset={() => resetSection('email')}
          resetting={saveMut.isPending}
          onClearSecret={clearSecret}
        />
      )}

      {section === 'ai' && (
        <AiSection
          form={form}
          settings={settings}
          secretDrafts={secretDrafts}
          setField={setField}
          setSecretDrafts={setSecretDrafts}
          onReset={() => resetSection('ai')}
          resetting={saveMut.isPending}
          onClearSecret={clearSecret}
        />
      )}

      {section === 'security' && (
        <SecuritySection
          form={form}
          settings={settings}
          setField={setField}
          onReset={() => resetSection('security')}
          resetting={saveMut.isPending}
        />
      )}

      {section === 'storage' && (
        <StorageSection
          form={form}
          settings={settings}
          setField={setField}
          onReset={() => resetSection('storage')}
          resetting={saveMut.isPending}
        />
      )}

      {section === 'observability' && (
        <ObservabilitySection
          form={form}
          settings={settings}
          setField={setField}
          onReset={() => resetSection('observability')}
          resetting={saveMut.isPending}
        />
      )}

      {section === 'system' && <SystemCard system={settings.system} />}
    </div>
  )
}
