import type { ServiceSettings } from '@/types'
import { Field, SCard, TextArea, TextInput, ToggleRow } from '@/components/settings/kit'
import { ResetRow, SourceBadge } from './ServiceSettingsPrimitives'
import type { EditableSettings, SectionKey } from './serviceSettingsHelpers'
import { sourceFor } from './serviceSettingsHelpers'

export function SecuritySection({
  form,
  settings,
  setField,
  onReset,
  resetting,
}: {
  form: EditableSettings
  settings: ServiceSettings
  setField: (section: SectionKey, field: string, value: string | number | boolean) => void
  onReset: () => void
  resetting: boolean
}) {
  return (
    <>
      <SCard title="Sessions" footer={<ResetRow onReset={onReset} resetting={resetting} />}>
        <Field
          label="Session cookie"
          labelRight={<SourceBadge source={sourceFor(settings, 'security', 'session_cookie_name')} />}
        >
          <TextInput
            value={form.security.session_cookie_name}
            onChange={value => setField('security', 'session_cookie_name', value)}
            mono
          />
        </Field>
        <Field
          label="Session TTL"
          labelRight={<SourceBadge source={sourceFor(settings, 'security', 'session_ttl_hours')} />}
        >
          <TextInput
            type="number"
            value={String(form.security.session_ttl_hours)}
            onChange={value => setField('security', 'session_ttl_hours', Number(value))}
            suffix="hours"
            mono
          />
        </Field>
        <ToggleRow
          label="Secure cookie"
          labelRight={
            <SourceBadge source={sourceFor(settings, 'security', 'session_cookie_secure')} />
          }
          value={form.security.session_cookie_secure}
          onChange={value => setField('security', 'session_cookie_secure', value)}
          last
        />
      </SCard>

      <SCard title="Network & headers">
        <Field
          label="CORS allow origins"
          labelRight={<SourceBadge source={sourceFor(settings, 'security', 'cors_allow_origins')} />}
        >
          <TextInput
            value={form.security.cors_allow_origins}
            onChange={value => setField('security', 'cors_allow_origins', value)}
            placeholder="https://app.example.com,https://admin.example.com"
            mono
          />
        </Field>
        <ToggleRow
          label="Security headers"
          labelRight={
            <SourceBadge source={sourceFor(settings, 'security', 'security_headers_enabled')} />
          }
          value={form.security.security_headers_enabled}
          onChange={value => setField('security', 'security_headers_enabled', value)}
        />
        <ToggleRow
          label="HSTS"
          labelRight={<SourceBadge source={sourceFor(settings, 'security', 'hsts_enabled')} />}
          value={form.security.hsts_enabled}
          onChange={value => setField('security', 'hsts_enabled', value)}
        />
        <Field
          label="HSTS max age"
          labelRight={<SourceBadge source={sourceFor(settings, 'security', 'hsts_max_age_seconds')} />}
        >
          <TextInput
            type="number"
            value={String(form.security.hsts_max_age_seconds)}
            onChange={value => setField('security', 'hsts_max_age_seconds', Number(value))}
            suffix="seconds"
            mono
          />
        </Field>
        <Field
          label="Content Security Policy"
          labelRight={
            <SourceBadge source={sourceFor(settings, 'security', 'content_security_policy')} />
          }
          stacked
          last
        >
          <TextArea
            value={form.security.content_security_policy}
            onChange={value => setField('security', 'content_security_policy', value)}
          />
        </Field>
      </SCard>

      <SCard title="Rate limiting">
        <ToggleRow
          label="Rate limiting"
          labelRight={<SourceBadge source={sourceFor(settings, 'security', 'rate_limit_enabled')} />}
          value={form.security.rate_limit_enabled}
          onChange={value => setField('security', 'rate_limit_enabled', value)}
        />
        <Field
          label="Login limit"
          labelRight={
            <SourceBadge source={sourceFor(settings, 'security', 'rate_limit_login_per_minute')} />
          }
        >
          <TextInput
            type="number"
            value={String(form.security.rate_limit_login_per_minute)}
            onChange={value => setField('security', 'rate_limit_login_per_minute', Number(value))}
            suffix="/min"
            mono
          />
        </Field>
        <Field
          label="Register limit"
          labelRight={
            <SourceBadge source={sourceFor(settings, 'security', 'rate_limit_register_per_hour')} />
          }
        >
          <TextInput
            type="number"
            value={String(form.security.rate_limit_register_per_hour)}
            onChange={value => setField('security', 'rate_limit_register_per_hour', Number(value))}
            suffix="/hour"
            mono
          />
        </Field>
        <ToggleRow
          label="Trust X-Forwarded-For"
          labelRight={
            <SourceBadge
              source={sourceFor(settings, 'security', 'rate_limit_trust_forwarded_for')}
            />
          }
          value={form.security.rate_limit_trust_forwarded_for}
          onChange={value => setField('security', 'rate_limit_trust_forwarded_for', value)}
          last
        />
      </SCard>
    </>
  )
}
