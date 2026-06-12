import { Activity } from 'lucide-react'
import type { ServiceSettings } from '@/types'
import { Input } from '@/components/ui/input'
import { FieldRow, SectionCard, SwitchRow } from './ServiceSettingsPrimitives'
import type { EditableSettings, SectionKey } from './serviceSettingsHelpers'
import { sourceFor } from './serviceSettingsHelpers'

export function ObservabilitySection({
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
      title="Observability"
      icon={Activity}
      onReset={onReset}
      resetting={resetting}
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
  )
}
