import type { ServiceSettings } from '@/types'
import { Button } from '@/components/ui/button'
import { Field, SCard, TextInput, ToggleRow } from '@/components/settings/kit'
import { SourceBadge } from './ServiceSettingsPrimitives'
import type {
  EditableSettings,
  SecretDrafts,
  SecretField,
  SectionKey,
} from './serviceSettingsHelpers'
import { sourceFor } from './serviceSettingsHelpers'

export function EmailSection({
  form,
  settings,
  secretDrafts,
  setField,
  setSecretDrafts,
  saving,
  onClearSecret,
}: {
  form: EditableSettings
  settings: ServiceSettings
  secretDrafts: SecretDrafts
  setField: (section: SectionKey, field: string, value: string | number | boolean) => void
  setSecretDrafts: (updater: (current: SecretDrafts) => SecretDrafts) => void
  saving: boolean
  onClearSecret: (section: 'ai' | 'email', field: SecretField) => void
}) {
  return (
    <>
      <SCard title="SMTP">
        <Field
          label="SMTP host"
          labelRight={<SourceBadge source={sourceFor(settings, 'email', 'smtp_host')} />}
        >
          <TextInput
            value={form.email.smtp_host}
            onChange={value => setField('email', 'smtp_host', value)}
            mono
          />
        </Field>
        <Field
          label="Port"
          labelRight={<SourceBadge source={sourceFor(settings, 'email', 'smtp_port')} />}
        >
          <TextInput
            type="number"
            value={String(form.email.smtp_port)}
            onChange={value => setField('email', 'smtp_port', Number(value))}
            mono
          />
        </Field>
        <Field
          label="SMTP username"
          labelRight={<SourceBadge source={sourceFor(settings, 'email', 'smtp_username')} />}
        >
          <TextInput
            value={form.email.smtp_username}
            onChange={value => setField('email', 'smtp_username', value)}
            mono
          />
        </Field>
        <Field
          label="SMTP password"
          labelRight={<SourceBadge source={sourceFor(settings, 'email', 'smtp_password')} />}
        >
          <div className="flex gap-2">
            <div className="flex-1">
              <TextInput
                type="password"
                value={secretDrafts.smtp_password}
                onChange={value =>
                  setSecretDrafts(current => ({ ...current, smtp_password: value }))
                }
                placeholder={
                  form.email.smtp_password_configured
                    ? 'Configured — leave blank to keep'
                    : 'Not configured'
                }
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onClearSecret('email', 'smtp_password')}
              disabled={saving}
            >
              Clear
            </Button>
          </div>
        </Field>
        <ToggleRow
          label="Use TLS"
          labelRight={<SourceBadge source={sourceFor(settings, 'email', 'smtp_use_tls')} />}
          value={form.email.smtp_use_tls}
          onChange={value => setField('email', 'smtp_use_tls', value)}
          last
        />
      </SCard>

      <SCard title="Sender">
        <Field
          label="Default From address"
          labelRight={<SourceBadge source={sourceFor(settings, 'email', 'smtp_from_address')} />}
          last
        >
          <TextInput
            value={form.email.smtp_from_address}
            onChange={value => setField('email', 'smtp_from_address', value)}
            mono
          />
        </Field>
      </SCard>
    </>
  )
}
