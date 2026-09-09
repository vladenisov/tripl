import { MailCheck } from 'lucide-react'
import { useMutation } from '@tanstack/react-query'
import { serviceSettingsApi } from '@/api/serviceSettings'
import type { ServiceSettings } from '@/types'
import { Button } from '@/components/ui/button'
import { Field, SCard, Select, TextInput } from '@/components/settings/kit'
import { SourceBadge, StatusBadge } from './ServiceSettingsPrimitives'
import type {
  EditableSettings,
  SecretDrafts,
  SecretField,
  SectionKey,
} from './serviceSettingsHelpers'
import { sourceFor } from './serviceSettingsHelpers'

// Ports named in the labels because the mode and the port have to agree, and
// disagreeing does not produce an error the operator can act on — the client
// waits for a greeting that never arrives and stalls until it times out.
const SECURITY_OPTIONS = [
  { value: 'starttls', label: 'STARTTLS — upgrade after connecting (587, 2525)' },
  { value: 'implicit_tls', label: 'Implicit TLS — encrypted from the start (465)' },
  { value: 'none', label: 'None — plaintext' },
] as const

const SECURITY_HINTS: Record<string, string> = {
  starttls:
    'Connects in the clear, reads the server greeting, then upgrades. What submission ports 587 and 2525 expect.',
  implicit_tls:
    'Wraps the connection in TLS before sending anything, so the greeting itself is encrypted. What port 465 expects.',
  none: 'No encryption at all. Only reasonable for a relay on localhost or a network path you already trust.',
}

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
  const emailTestMut = useMutation({
    mutationFn: () => serviceSettingsApi.testEmail(),
  })

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
        <Field
          label="Security"
          htmlFor="email-smtp-security"
          labelRight={<SourceBadge source={sourceFor(settings, 'email', 'smtp_security')} />}
          // Stacked because the hint is a sentence, and this is the one field on
          // the card whose wrong value produces no error message anywhere — the
          // send just hangs. It replaced a "Use TLS" switch that could only ever
          // mean STARTTLS, which is why a 465 relay was unreachable however it
          // was set (tripl-x1vk).
          stacked
          hint={SECURITY_HINTS[form.email.smtp_security]}
          last
        >
          <Select
            id="email-smtp-security"
            value={form.email.smtp_security}
            onChange={value => setField('email', 'smtp_security', value)}
            options={SECURITY_OPTIONS}
          />
        </Field>
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

      <SCard
        title="Check"
        description="Sends one message to your own address using the SAVED settings — save first, or you will be testing what is still stored."
      >
        {/* A test button and its status line, not a control to be named —
            the same shape the AI section uses. This card is the whole point of
            tripl-wmpe: a failed password-reset send is deliberately invisible to
            the person who asked for the link, so the operator needs somewhere
            else to look, and until now there was nowhere. */}
        <Field label="Delivery" last htmlFor={false}>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => emailTestMut.mutate()}
              disabled={emailTestMut.isPending || saving}
            >
              <MailCheck className="h-3.5 w-3.5" />
              {emailTestMut.isPending ? 'Sending...' : 'Send test email'}
            </Button>
            <span role="status" aria-live="polite" aria-atomic="true" className="inline-flex">
              {emailTestMut.data && (
                <StatusBadge active={emailTestMut.data.ok} label={emailTestMut.data.message} />
              )}
            </span>
          </div>
        </Field>
      </SCard>
    </>
  )
}
