import type { ServiceSettings } from '@/types'
import { Field, SCard, TextInput } from '@/components/settings/kit'
import { SourceBadge } from './ServiceSettingsPrimitives'
import type { EditableSettings, SectionKey } from './serviceSettingsHelpers'
import { sourceFor } from './serviceSettingsHelpers'

export function RuntimeSection({
  form,
  settings,
  setField,
}: {
  form: EditableSettings
  settings: ServiceSettings
  setField: (section: SectionKey, field: string, value: string | number | boolean) => void
}) {
  return (
    <>
      <SCard title="Server">
        <Field
          label="App base URL"
          hint="Used in emails, webhooks and the ingest endpoint."
          labelRight={<SourceBadge source={sourceFor(settings, 'runtime', 'app_base_url')} />}
          last
        >
          <TextInput
            value={form.runtime.app_base_url}
            onChange={value => setField('runtime', 'app_base_url', value)}
            placeholder="https://tripl.example.com"
            mono
          />
        </Field>
      </SCard>

      <SCard title="Query limits">
        <Field
          label="Scan row limit default"
          labelRight={<SourceBadge source={sourceFor(settings, 'runtime', 'scan_row_limit_default')} />}
        >
          <TextInput
            type="number"
            value={String(form.runtime.scan_row_limit_default)}
            onChange={value => setField('runtime', 'scan_row_limit_default', Number(value))}
            suffix="rows"
            mono
          />
        </Field>
        <Field
          label="Metrics row limit default"
          labelRight={<SourceBadge source={sourceFor(settings, 'runtime', 'metrics_row_limit_default')} />}
          last
        >
          <TextInput
            type="number"
            value={String(form.runtime.metrics_row_limit_default)}
            onChange={value => setField('runtime', 'metrics_row_limit_default', Number(value))}
            suffix="rows"
            mono
          />
        </Field>
      </SCard>
    </>
  )
}
