import { HardDrive } from 'lucide-react'
import type { ServiceSettings } from '@/types'
import { Input } from '@/components/ui/input'
import { FieldRow, SectionCard, SelectRow, SwitchRow } from './ServiceSettingsPrimitives'
import type { EditableSettings, SectionKey } from './serviceSettingsHelpers'
import { sourceFor } from './serviceSettingsHelpers'

const PHOTO_STORAGE_BACKEND_OPTIONS = [
  { value: 'local', label: 'Local filesystem' },
  { value: 'gcs', label: 'Google Cloud Storage' },
] as const

export function StorageSection({
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
      title="Storage"
      icon={HardDrive}
      onReset={onReset}
      resetting={resetting}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectRow
          label="Photo storage backend"
          source={sourceFor(settings, 'storage', 'photo_storage_backend')}
          value={form.storage.photo_storage_backend}
          options={PHOTO_STORAGE_BACKEND_OPTIONS}
          onChange={value => setField('storage', 'photo_storage_backend', value)}
        />
        <FieldRow
          label="Photo max size MB"
          source={sourceFor(settings, 'storage', 'photo_max_size_mb')}
        >
          <Input
            type="number"
            min={1}
            value={form.storage.photo_max_size_mb}
            onChange={event =>
              setField('storage', 'photo_max_size_mb', Number(event.target.value))
            }
          />
        </FieldRow>
      </div>
      <FieldRow label="Local photo directory" source={sourceFor(settings, 'storage', 'photo_local_dir')}>
        <Input
          value={form.storage.photo_local_dir}
          onChange={event => setField('storage', 'photo_local_dir', event.target.value)}
        />
      </FieldRow>
      <FieldRow
        label="Allowed MIME types"
        source={sourceFor(settings, 'storage', 'photo_allowed_mime')}
      >
        <Input
          value={form.storage.photo_allowed_mime}
          onChange={event => setField('storage', 'photo_allowed_mime', event.target.value)}
        />
      </FieldRow>
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldRow label="GCS bucket" source={sourceFor(settings, 'storage', 'gcs_photo_bucket')}>
          <Input
            value={form.storage.gcs_photo_bucket}
            onChange={event => setField('storage', 'gcs_photo_bucket', event.target.value)}
          />
        </FieldRow>
        <SwitchRow
          label="GCS public URLs"
          source={sourceFor(settings, 'storage', 'gcs_photo_public')}
          checked={form.storage.gcs_photo_public}
          onChange={value => setField('storage', 'gcs_photo_public', value)}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_180px]">
        <FieldRow
          label="GCS credentials path"
          source={sourceFor(settings, 'storage', 'gcs_photo_credentials_path')}
        >
          <Input
            value={form.storage.gcs_photo_credentials_path}
            onChange={event =>
              setField('storage', 'gcs_photo_credentials_path', event.target.value)
            }
          />
        </FieldRow>
        <FieldRow
          label="Signed URL TTL"
          source={sourceFor(settings, 'storage', 'gcs_photo_signed_url_ttl_seconds')}
        >
          <Input
            type="number"
            min={1}
            value={form.storage.gcs_photo_signed_url_ttl_seconds}
            onChange={event =>
              setField(
                'storage',
                'gcs_photo_signed_url_ttl_seconds',
                Number(event.target.value),
              )
            }
          />
        </FieldRow>
      </div>
    </SectionCard>
  )
}
