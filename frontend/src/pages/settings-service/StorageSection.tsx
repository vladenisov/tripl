import type { ServiceSettings } from '@/types'
import { Field, RadioCards, SCard, TextInput, ToggleRow } from '@/components/settings/kit'
import { SourceBadge } from './ServiceSettingsPrimitives'
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
}: {
  form: EditableSettings
  settings: ServiceSettings
  setField: (section: SectionKey, field: string, value: string | number | boolean) => void
}) {
  return (
    <>
      <SCard title="Backend">
        <Field
          label="Photo storage backend"
          labelRight={
            <SourceBadge source={sourceFor(settings, 'storage', 'photo_storage_backend')} />
          }
          stacked
        >
          <RadioCards
            groupLabel="Photo storage backend"
            value={form.storage.photo_storage_backend}
            onChange={value => setField('storage', 'photo_storage_backend', value)}
            options={PHOTO_STORAGE_BACKEND_OPTIONS}
            columns={2}
          />
        </Field>
        <Field
          label="Photo max size"
          labelRight={<SourceBadge source={sourceFor(settings, 'storage', 'photo_max_size_mb')} />}
        >
          <TextInput
            type="number"
            value={String(form.storage.photo_max_size_mb)}
            onChange={value => setField('storage', 'photo_max_size_mb', Number(value))}
            suffix="MB"
            mono
          />
        </Field>
        <Field
          label="Allowed MIME types"
          labelRight={<SourceBadge source={sourceFor(settings, 'storage', 'photo_allowed_mime')} />}
          last
        >
          <TextInput
            value={form.storage.photo_allowed_mime}
            onChange={value => setField('storage', 'photo_allowed_mime', value)}
            mono
          />
        </Field>
      </SCard>

      <SCard title="Local filesystem">
        <Field
          label="Local photo directory"
          labelRight={<SourceBadge source={sourceFor(settings, 'storage', 'photo_local_dir')} />}
          last
        >
          <TextInput
            value={form.storage.photo_local_dir}
            onChange={value => setField('storage', 'photo_local_dir', value)}
            mono
          />
        </Field>
      </SCard>

      <SCard title="Google Cloud Storage">
        <Field
          label="GCS bucket"
          labelRight={<SourceBadge source={sourceFor(settings, 'storage', 'gcs_photo_bucket')} />}
        >
          <TextInput
            value={form.storage.gcs_photo_bucket}
            onChange={value => setField('storage', 'gcs_photo_bucket', value)}
            mono
          />
        </Field>
        <ToggleRow
          label="GCS public URLs"
          labelRight={<SourceBadge source={sourceFor(settings, 'storage', 'gcs_photo_public')} />}
          value={form.storage.gcs_photo_public}
          onChange={value => setField('storage', 'gcs_photo_public', value)}
        />
        <Field
          label="GCS credentials path"
          labelRight={
            <SourceBadge source={sourceFor(settings, 'storage', 'gcs_photo_credentials_path')} />
          }
        >
          <TextInput
            value={form.storage.gcs_photo_credentials_path}
            onChange={value => setField('storage', 'gcs_photo_credentials_path', value)}
            mono
          />
        </Field>
        <Field
          label="Signed URL TTL"
          labelRight={
            <SourceBadge
              source={sourceFor(settings, 'storage', 'gcs_photo_signed_url_ttl_seconds')}
            />
          }
          last
        >
          <TextInput
            type="number"
            value={String(form.storage.gcs_photo_signed_url_ttl_seconds)}
            onChange={value =>
              setField('storage', 'gcs_photo_signed_url_ttl_seconds', Number(value))
            }
            suffix="seconds"
            mono
          />
        </Field>
      </SCard>
    </>
  )
}
