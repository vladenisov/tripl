import { Mail } from 'lucide-react'
import type { ServiceSettings } from '@/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FieldRow, SectionCard, SwitchRow } from './ServiceSettingsPrimitives'
import type { EditableSettings, SecretDrafts, SectionKey } from './serviceSettingsHelpers'
import { sourceFor } from './serviceSettingsHelpers'

export function EmailSection({
  form,
  settings,
  secretDrafts,
  setField,
  setSecretDrafts,
  onReset,
  resetting,
  onClearSecret,
}: {
  form: EditableSettings
  settings: ServiceSettings
  secretDrafts: SecretDrafts
  setField: (section: SectionKey, field: string, value: string | number | boolean) => void
  setSecretDrafts: (updater: (current: SecretDrafts) => SecretDrafts) => void
  onReset: () => void
  resetting: boolean
  onClearSecret: (section: 'ai' | 'email', field: string) => void
}) {
  return (
    <SectionCard
      title="Email"
      icon={Mail}
      onReset={onReset}
      resetting={resetting}
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
      <FieldRow label="SMTP password" source={sourceFor(settings, 'email', 'smtp_password_configured' as never)}>
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
            onClick={() => onClearSecret('email', 'smtp_password')}
            disabled={resetting}
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
  )
}
