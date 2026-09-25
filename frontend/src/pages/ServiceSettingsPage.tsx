import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Save } from 'lucide-react'

import { serviceSettingsApi } from '@/api/serviceSettings'
import type { ServiceSettingsSectionKey } from './serviceSettingsTabs'
import { useAuth } from '@/components/auth-context'
import { useUnsavedChanges } from '@/components/settings/unsaved-changes'
import { ErrorState } from '@/components/error-state'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useConfirm } from '@/hooks/useConfirm'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { getErrorMessage } from '@/lib/utils'
import type { ServiceSettings, ServiceSettingsUpdate } from '@/types'

import { AiSection } from './settings-service/AiSection'
import { EmailSection } from './settings-service/EmailSection'
import { ObservabilitySection } from './settings-service/ObservabilitySection'
import { RuntimeSection } from './settings-service/RuntimeSection'
import { SecuritySection } from './settings-service/SecuritySection'
import {
  InstanceSettingsSkeleton,
  ResetSectionCard,
} from './settings-service/ServiceSettingsPrimitives'
import { StorageSection } from './settings-service/StorageSection'
import { SystemCard } from './settings-service/SystemCard'
import {
  type EditableSettings,
  type SecretDrafts,
  type SecretField,
  type SectionKey,
  EMPTY_SECRET_DRAFTS,
  SECTION_LABELS,
  adoptSection,
  adoptSectionKeepingEdits,
  applyNote,
  buildUpdate,
  clearSecretConfirm,
  clearSectionSecrets,
  dirtySections,
  editableFromSettings,
  hasUpdate,
  lockoutRisks,
  overrideCount,
  pickSection,
  resetConfirm,
  resetPayload,
  sectionHasInvalidNumber,
} from './settings-service/serviceSettingsHelpers'
import { isOwner } from '@/lib/permissions'

const UNSAVED_MESSAGE =
  'Instance settings you edited here have not been saved. Leaving this page drops them — anything typed into a prompt or a field is gone.'

/**
 * What one PATCH to the settings endpoint is doing.
 *
 * All three send the same request and get the same whole-settings response, but
 * they may not adopt it the same way. Every one of them writes a single
 * section — Save included: it used to send the whole form, so a Security edit
 * left behind while the owner moved on to AI went out with AI's Save and
 * nothing on the AI page said so — and each must leave the other five
 * sections' unsaved edits standing. Clear additionally keeps the edits in its
 * own section (tripl-ifiy, tripl-l8v2).
 */
type SettingsWrite =
  | { kind: 'save'; section: SectionKey; update: ServiceSettingsUpdate }
  | { kind: 'reset'; section: SectionKey }
  | { kind: 'clear-secret'; group: 'ai' | 'email'; field: SecretField }

function writesAi(write: SettingsWrite): boolean {
  return write.kind === 'clear-secret' ? write.group === 'ai' : write.section === 'ai'
}

function payloadFor(write: SettingsWrite): ServiceSettingsUpdate {
  if (write.kind === 'save') return write.update
  if (write.kind === 'reset') return resetPayload(write.section)
  return { [write.group]: { [write.field]: null } } as ServiceSettingsUpdate
}

export default function ServiceSettingsSection({
  section,
}: {
  section: ServiceSettingsSectionKey
}) {
  const { user } = useAuth()
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const { registerUnsaved } = useUnsavedChanges()
  const [form, setForm] = useState<EditableSettings | null>(null)
  const [secretDrafts, setSecretDrafts] = useState<SecretDrafts>(EMPTY_SECRET_DRAFTS)
  const [hydratedSettings, setHydratedSettings] = useState<ServiceSettings | null>(null)

  const settingsQuery = useQuery({
    queryKey: ['serviceSettings'],
    queryFn: serviceSettingsApi.get,
    enabled: isOwner(user?.role),
    // Rendered below as an ErrorState with a retry.
    meta: SILENT_ERROR_META,
  })

  if (settingsQuery.data && hydratedSettings !== settingsQuery.data) {
    setHydratedSettings(settingsQuery.data)
    setForm(editableFromSettings(settingsQuery.data))
    setSecretDrafts(EMPTY_SECRET_DRAFTS)
  }

  const saveMut = useMutation({
    mutationFn: (write: SettingsWrite) => serviceSettingsApi.update(payloadFor(write)),
    // Shown in the sticky save row.
    meta: SILENT_ERROR_META,
    onSuccess: (data, write) => {
      qc.setQueryData(['serviceSettings'], data)
      setHydratedSettings(data)
      // Whether a project shows its AI buttons is cached for five minutes
      // (useAiStatus); without this an owner who just turned AI on went back
      // to a project and still saw it off.
      if (writesAi(write)) void qc.invalidateQueries({ queryKey: ['aiStatus'] })
      // A write settles only what it wrote. `form` spans all six sections, so
      // replacing it here threw away an unsaved prompt or field in a section
      // this action never touched (tripl-l8v2).
      if (write.kind === 'save' || write.kind === 'reset') {
        setForm(current => (current ? adoptSection(current, data, write.section) : current))
        setSecretDrafts(current => clearSectionSecrets(current, write.section))
        return
      }
      setForm(current => (current ? adoptSectionKeepingEdits(current, data, write.group) : current))
      setSecretDrafts(current => ({ ...current, [write.field]: '' }))
    },
  })

  const update = useMemo(
    () => buildUpdate(form, settingsQuery.data, secretDrafts),
    [form, settingsQuery.data, secretDrafts],
  )
  const dirty = hasUpdate(update)
  const activeSection: SectionKey | null = section === 'system' ? null : section
  const sectionUpdate = useMemo(
    () => (activeSection ? pickSection(update, activeSection) : {}),
    [update, activeSection],
  )
  const sectionDirty = hasUpdate(sectionUpdate)
  const otherDirty = dirtySections(update).filter(key => key !== activeSection)
  const sectionInvalid = form !== null && activeSection !== null && sectionHasInvalidNumber(form, activeSection)

  // buildUpdate spans every section, and switching between two instance
  // sections keeps this component mounted, so only leaving the instance group
  // actually loses the draft (tripl-l8v2).
  useEffect(() => {
    registerUnsaved(
      dirty ? { keptBy: path => path.startsWith('instance/'), message: UNSAVED_MESSAGE } : null,
    )
    return () => registerUnsaved(null)
  }, [dirty, registerUnsaved])

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

  // Both of these write straight through to the server — no Save step, no undo
  // (the backend pops the override permanently), and on Security a reset can
  // reopen public signup. They are gated the way every other destructive action
  // in the app is (tripl-ifiy).
  const resetSection = async (target: SectionKey) => {
    const sectionDraft = Object.keys(update[target] ?? {}).length > 0
    const ok = await confirm({ ...resetConfirm(target, sectionDraft), variant: 'danger' })
    if (ok) saveMut.mutate({ kind: 'reset', section: target })
  }

  const clearSecret = async (group: 'ai' | 'email', field: SecretField) => {
    const fieldDraft = secretDrafts[field].trim().length > 0
    const ok = await confirm({ ...clearSecretConfirm(field, fieldDraft), variant: 'danger' })
    if (ok) saveMut.mutate({ kind: 'clear-secret', group, field })
  }

  // Security changes that can lock people out or break this app are confirmed
  // the way Reset and Clear are; everything else saves directly.
  const save = async () => {
    if (!activeSection) return
    const risks = lockoutRisks(sectionUpdate)
    if (risks.length > 0) {
      const ok = await confirm({
        title: 'Save changes that can lock people out?',
        message: `${risks.join(' ')} Make sure you can still reach this instance before saving.`,
        confirmLabel: 'Save anyway',
        variant: 'danger',
      })
      if (!ok) return
    }
    saveMut.mutate({ kind: 'save', section: activeSection, update: sectionUpdate })
  }

  // Discards this section only, like Save.
  const discard = () => {
    const saved = settingsQuery.data
    if (!saved || !activeSection) return
    setForm(existing => (existing ? adoptSection(existing, saved, activeSection) : existing))
    setSecretDrafts(existing => clearSectionSecrets(existing, activeSection))
  }

  if (!isOwner(user?.role)) {
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

  // The error check has to come first: a failed GET leaves `data` undefined,
  // and the loading branch used to catch that and show "Loading…" forever.
  if (settingsQuery.isError && !settingsQuery.data) {
    return (
      <ErrorState
        title="Couldn't load instance settings"
        error={settingsQuery.error}
        onRetry={() => {
          void settingsQuery.refetch()
        }}
      />
    )
  }

  if (!settingsQuery.data || !form) {
    return <InstanceSettingsSkeleton />
  }

  const settings = settingsQuery.data

  return (
    <div className="min-w-0 space-y-5">
      {dialog}
      {section !== 'system' && (
        <div
          // The only Save control used to be a non-sticky first child of the
          // scrolling pane, so the AI page's three prompt textareas — the
          // fields most likely to be edited — were all edited with it
          // off-screen (tripl-l8v2). `top-[52px]` clears the phone-only header
          // in SettingsLayout; from `md` up that header is gone.
          className="sticky top-[52px] z-10 flex flex-wrap items-center justify-between gap-3 py-3 md:top-0"
          style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border-subtle)' }}
        >
          {/* 12.5px, the kit's body-sm: at text-sm this note sat above the
              13px page description in weight. */}
          <div className="min-w-0 flex-1 basis-64 text-[12.5px] leading-[1.5] text-muted-foreground">
            <p>{applyNote(section)}</p>
            {otherDirty.length > 0 && (
              <p className="mt-1" style={{ color: 'var(--warning)' }}>
                Also unsaved: {otherDirty.map(key => SECTION_LABELS[key]).join(', ')}. Save
                changes here saves {SECTION_LABELS[section]} only.
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            {saveMut.isError && (
              <span role="alert" className="text-xs text-destructive">
                {getErrorMessage(saveMut.error)}
              </span>
            )}
            {sectionInvalid && (
              <span className="text-xs text-destructive">Fix the highlighted fields to save.</span>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={discard}
              disabled={!sectionDirty || saveMut.isPending}
            >
              Discard
            </Button>
            <Button
              type="button"
              onClick={() => void save()}
              disabled={!sectionDirty || sectionInvalid || saveMut.isPending}
              // A neutral surface when disabled: the default half-opacity teal
              // read as an enabled button.
              className="disabled:bg-[var(--bg-sunken)] disabled:text-[var(--fg-subtle)] disabled:opacity-100 disabled:shadow-none"
            >
              <Save className="h-3.5 w-3.5" />
              {saveMut.isPending ? 'Saving...' : 'Save changes'}
            </Button>
          </div>
        </div>
      )}

      {section === 'runtime' && (
        <RuntimeSection form={form} settings={settings} setField={setField} />
      )}

      {section === 'email' && (
        <EmailSection
          form={form}
          settings={settings}
          secretDrafts={secretDrafts}
          setField={setField}
          setSecretDrafts={setSecretDrafts}
          saving={saveMut.isPending}
          onClearSecret={(group, field) => void clearSecret(group, field)}
        />
      )}

      {section === 'ai' && (
        <AiSection
          form={form}
          settings={settings}
          secretDrafts={secretDrafts}
          setField={setField}
          setSecretDrafts={setSecretDrafts}
          saving={saveMut.isPending}
          onClearSecret={(group, field) => void clearSecret(group, field)}
        />
      )}

      {section === 'security' && (
        <SecuritySection form={form} settings={settings} setField={setField} />
      )}

      {section === 'storage' && (
        <StorageSection form={form} settings={settings} setField={setField} />
      )}

      {section === 'observability' && (
        <ObservabilitySection form={form} settings={settings} setField={setField} />
      )}

      {section === 'system' && <SystemCard system={settings.system} />}

      {section !== 'system' && (
        <ResetSectionCard
          section={section}
          overrides={overrideCount(settings, section)}
          onReset={() => void resetSection(section)}
          resetting={saveMut.isPending}
        />
      )}
    </div>
  )
}
