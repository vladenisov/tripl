import { KeyRound } from 'lucide-react'
import { useMutation } from '@tanstack/react-query'
import { serviceSettingsApi } from '@/api/serviceSettings'
import type { ServiceSettings } from '@/types'
import { Button } from '@/components/ui/button'
import { Field, SCard, TextArea, TextInput, ToggleRow } from '@/components/settings/kit'
import { SourceBadge, StatusBadge } from './ServiceSettingsPrimitives'
import type {
  EditableSettings,
  SecretDrafts,
  SecretField,
  SectionKey,
} from './serviceSettingsHelpers'
import { sourceFor } from './serviceSettingsHelpers'

export function AiSection({
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
  const aiTestMut = useMutation({
    mutationFn: () => serviceSettingsApi.testAi(),
  })

  return (
    <>
      <SCard title="Provider">
        <ToggleRow
          label="AI enabled"
          labelRight={<SourceBadge source={sourceFor(settings, 'ai', 'ai_enabled')} />}
          value={form.ai.ai_enabled}
          onChange={value => setField('ai', 'ai_enabled', value)}
        />
        <Field
          label="Base URL"
          labelRight={<SourceBadge source={sourceFor(settings, 'ai', 'ai_base_url')} />}
        >
          <TextInput
            value={form.ai.ai_base_url}
            onChange={value => setField('ai', 'ai_base_url', value)}
            mono
          />
        </Field>
        <Field
          label="Model"
          labelRight={<SourceBadge source={sourceFor(settings, 'ai', 'ai_model')} />}
        >
          <TextInput
            value={form.ai.ai_model}
            onChange={value => setField('ai', 'ai_model', value)}
            mono
          />
        </Field>
        <Field label="AI API key">
          <div className="flex gap-2">
            <div className="flex-1">
              <TextInput
                type="password"
                value={secretDrafts.ai_api_key}
                onChange={value =>
                  setSecretDrafts(current => ({ ...current, ai_api_key: value }))
                }
                placeholder={
                  form.ai.ai_api_key_configured
                    ? 'Configured — leave blank to keep'
                    : 'Not configured'
                }
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onClearSecret('ai', 'ai_api_key')}
              disabled={saving}
            >
              Clear
            </Button>
          </div>
        </Field>
        <Field label="Connection" last>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => aiTestMut.mutate()}
              disabled={aiTestMut.isPending}
            >
              <KeyRound className="h-3.5 w-3.5" />
              {aiTestMut.isPending ? 'Testing...' : 'Test AI'}
            </Button>
            <span role="status" aria-live="polite" aria-atomic="true" className="inline-flex">
              {aiTestMut.data && (
                <StatusBadge active={aiTestMut.data.ok} label={aiTestMut.data.message} />
              )}
            </span>
          </div>
        </Field>
      </SCard>

      <SCard title="Generation">
        <Field
          label="Timeout seconds"
          labelRight={<SourceBadge source={sourceFor(settings, 'ai', 'ai_timeout_seconds')} />}
        >
          <TextInput
            type="number"
            value={String(form.ai.ai_timeout_seconds)}
            onChange={value => setField('ai', 'ai_timeout_seconds', Number(value))}
            suffix="seconds"
            mono
          />
        </Field>
        <Field
          label="Max output tokens"
          labelRight={<SourceBadge source={sourceFor(settings, 'ai', 'ai_max_output_tokens')} />}
        >
          <TextInput
            type="number"
            value={String(form.ai.ai_max_output_tokens)}
            onChange={value => setField('ai', 'ai_max_output_tokens', Number(value))}
            mono
          />
        </Field>
        <Field
          label="Describe prompt"
          labelRight={<SourceBadge source={sourceFor(settings, 'ai', 'describe_system_prompt')} />}
          stacked
        >
          <TextArea
            value={form.ai.describe_system_prompt}
            onChange={value => setField('ai', 'describe_system_prompt', value)}
            mono
          />
        </Field>
        <Field
          label="Ask prompt"
          labelRight={<SourceBadge source={sourceFor(settings, 'ai', 'ask_system_prompt')} />}
          stacked
        >
          <TextArea
            value={form.ai.ask_system_prompt}
            onChange={value => setField('ai', 'ask_system_prompt', value)}
            mono
          />
        </Field>
        <Field
          label="Alert explanation prompt"
          labelRight={
            <SourceBadge source={sourceFor(settings, 'ai', 'alert_explanation_system_prompt')} />
          }
          stacked
          last
        >
          <TextArea
            value={form.ai.alert_explanation_system_prompt}
            onChange={value => setField('ai', 'alert_explanation_system_prompt', value)}
            mono
          />
        </Field>
      </SCard>

      <SCard title="Search embeddings">
        <ToggleRow
          label="Search embeddings"
          labelRight={
            <SourceBadge source={sourceFor(settings, 'ai', 'search_embeddings_enabled')} />
          }
          value={form.ai.search_embeddings_enabled}
          onChange={value => setField('ai', 'search_embeddings_enabled', value)}
        />
        <Field label="Embedding dimensions">
          <TextInput
            value={String(form.ai.search_embedding_dimensions)}
            disabled
            mono
          />
        </Field>
        <Field
          label="Embedding provider"
          labelRight={<SourceBadge source={sourceFor(settings, 'ai', 'search_embedding_provider')} />}
        >
          <TextInput
            value={form.ai.search_embedding_provider}
            onChange={value => setField('ai', 'search_embedding_provider', value)}
            mono
          />
        </Field>
        <Field
          label="Embedding model"
          labelRight={<SourceBadge source={sourceFor(settings, 'ai', 'search_embedding_model')} />}
        >
          <TextInput
            value={form.ai.search_embedding_model}
            onChange={value => setField('ai', 'search_embedding_model', value)}
            mono
          />
        </Field>
        <Field label="Embedding API key" last>
          <div className="flex gap-2">
            <div className="flex-1">
              <TextInput
                type="password"
                value={secretDrafts.search_embedding_api_key}
                onChange={value =>
                  setSecretDrafts(current => ({
                    ...current,
                    search_embedding_api_key: value,
                  }))
                }
                placeholder={
                  form.ai.search_embedding_api_key_configured
                    ? 'Configured — leave blank to keep'
                    : 'Not configured'
                }
              />
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onClearSecret('ai', 'search_embedding_api_key')}
              disabled={saving}
            >
              Clear
            </Button>
          </div>
        </Field>
      </SCard>
    </>
  )
}
