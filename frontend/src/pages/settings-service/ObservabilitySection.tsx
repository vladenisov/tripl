import type { ServiceSettings } from '@/types'
import { Field, SCard, Select, TextInput, ToggleRow } from '@/components/settings/kit'
import { ResetRow, SourceBadge } from './ServiceSettingsPrimitives'
import type { EditableSettings, SectionKey } from './serviceSettingsHelpers'
import { sourceFor } from './serviceSettingsHelpers'

const LOG_LEVEL_OPTIONS = [
  { value: 'DEBUG', label: 'DEBUG' },
  { value: 'INFO', label: 'INFO' },
  { value: 'WARNING', label: 'WARNING' },
  { value: 'ERROR', label: 'ERROR' },
  { value: 'CRITICAL', label: 'CRITICAL' },
] as const

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
    <>
      <SCard title="Logging" footer={<ResetRow onReset={onReset} resetting={resetting} />}>
        <Field
          label="Log level"
          labelRight={<SourceBadge source={sourceFor(settings, 'observability', 'log_level')} />}
        >
          <Select
            value={form.observability.log_level}
            onChange={value => setField('observability', 'log_level', value)}
            options={LOG_LEVEL_OPTIONS}
          />
        </Field>
        <ToggleRow
          label="JSON logs"
          labelRight={<SourceBadge source={sourceFor(settings, 'observability', 'log_json')} />}
          value={form.observability.log_json}
          onChange={value => setField('observability', 'log_json', value)}
        />
        <Field
          label="Request ID header"
          labelRight={
            <SourceBadge source={sourceFor(settings, 'observability', 'request_id_header')} />
          }
          last
        >
          <TextInput
            value={form.observability.request_id_header}
            onChange={value => setField('observability', 'request_id_header', value)}
            mono
          />
        </Field>
      </SCard>

      <SCard title="Metrics & tracing">
        <ToggleRow
          label="Prometheus metrics"
          labelRight={
            <SourceBadge
              source={sourceFor(settings, 'observability', 'prometheus_metrics_enabled')}
            />
          }
          value={form.observability.prometheus_metrics_enabled}
          onChange={value => setField('observability', 'prometheus_metrics_enabled', value)}
        />
        <Field
          label="OTLP endpoint"
          labelRight={
            <SourceBadge
              source={sourceFor(settings, 'observability', 'otel_exporter_otlp_endpoint')}
            />
          }
        >
          <TextInput
            value={form.observability.otel_exporter_otlp_endpoint}
            onChange={value => setField('observability', 'otel_exporter_otlp_endpoint', value)}
            mono
          />
        </Field>
        <Field
          label="OTEL service name"
          labelRight={
            <SourceBadge source={sourceFor(settings, 'observability', 'otel_service_name')} />
          }
          last
        >
          <TextInput
            value={form.observability.otel_service_name}
            onChange={value => setField('observability', 'otel_service_name', value)}
            mono
          />
        </Field>
      </SCard>
    </>
  )
}
