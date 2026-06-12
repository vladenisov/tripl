import { Shield } from 'lucide-react'
import type { ServiceSettings } from '@/types'
import { Input } from '@/components/ui/input'
import { FieldRow, PromptField, SectionCard, SwitchRow } from './ServiceSettingsPrimitives'
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
    <SectionCard
      title="Security"
      icon={Shield}
      onReset={onReset}
      resetting={resetting}
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
  )
}
