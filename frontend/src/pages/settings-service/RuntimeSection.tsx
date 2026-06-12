import { ServerCog } from 'lucide-react'
import type { ServiceSettings } from '@/types'
import { Input } from '@/components/ui/input'
import { FieldRow, SectionCard } from './ServiceSettingsPrimitives'
import type { EditableSettings, SectionKey } from './serviceSettingsHelpers'
import { sourceFor } from './serviceSettingsHelpers'

export function RuntimeSection({
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
      title="Runtime"
      icon={ServerCog}
      onReset={onReset}
      resetting={resetting}
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
  )
}
