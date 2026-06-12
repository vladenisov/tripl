import { Bot, KeyRound } from 'lucide-react'
import { useMutation } from '@tanstack/react-query'
import { serviceSettingsApi } from '@/api/serviceSettings'
import type { ServiceSettings } from '@/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { FieldRow, PromptField, SectionCard, StatusBadge, SwitchRow } from './ServiceSettingsPrimitives'
import type { EditableSettings, SecretDrafts, SectionKey } from './serviceSettingsHelpers'
import { sourceFor } from './serviceSettingsHelpers'

export function AiSection({
  form,
  settings,
  secretDrafts,
  setField,
  setSecretDrafts,
  onReset,
  resetting,
  onClearSecret,
}: {
  form: EditableSettings
  settings: ServiceSettings
  secretDrafts: SecretDrafts
  setField: (section: SectionKey, field: string, value: string | number | boolean) => void
  setSecretDrafts: (updater: (current: SecretDrafts) => SecretDrafts) => void
  onReset: () => void
  resetting: boolean
  onClearSecret: (section: 'ai' | 'email', field: string) => void
}) {
  const aiTestMut = useMutation({
    mutationFn: () => serviceSettingsApi.testAi(),
  })

  return (
    <SectionCard
      title="AI and embeddings"
      icon={Bot}
      onReset={onReset}
      resetting={resetting}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <SwitchRow
          label="AI enabled"
          source={sourceFor(settings, 'ai', 'ai_enabled')}
          checked={form.ai.ai_enabled}
          onChange={value => setField('ai', 'ai_enabled', value)}
        />
        <div className="flex items-end gap-2">
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
          {aiTestMut.data && (
            <StatusBadge active={aiTestMut.data.ok} label={aiTestMut.data.message} />
          )}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <FieldRow label="Base URL" source={sourceFor(settings, 'ai', 'ai_base_url')}>
          <Input
            value={form.ai.ai_base_url}
            onChange={event => setField('ai', 'ai_base_url', event.target.value)}
          />
        </FieldRow>
        <FieldRow label="Model" source={sourceFor(settings, 'ai', 'ai_model')}>
          <Input
            value={form.ai.ai_model}
            onChange={event => setField('ai', 'ai_model', event.target.value)}
          />
        </FieldRow>
      </div>
      <FieldRow label="AI API key" source={sourceFor(settings, 'ai', 'ai_api_key_configured' as never)}>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="password"
            value={secretDrafts.ai_api_key}
            onChange={event =>
              setSecretDrafts(current => ({
                ...current,
                ai_api_key: event.target.value,
              }))
            }
            placeholder={
              form.ai.ai_api_key_configured
                ? 'Configured - leave blank to keep'
                : 'Not configured'
            }
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onClearSecret('ai', 'ai_api_key')}
            disabled={resetting}
          >
            Clear
          </Button>
        </div>
      </FieldRow>
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldRow label="Timeout seconds" source={sourceFor(settings, 'ai', 'ai_timeout_seconds')}>
          <Input
            type="number"
            min={1}
            value={form.ai.ai_timeout_seconds}
            onChange={event => setField('ai', 'ai_timeout_seconds', Number(event.target.value))}
          />
        </FieldRow>
        <FieldRow label="Max output tokens" source={sourceFor(settings, 'ai', 'ai_max_output_tokens')}>
          <Input
            type="number"
            min={1}
            value={form.ai.ai_max_output_tokens}
            onChange={event => setField('ai', 'ai_max_output_tokens', Number(event.target.value))}
          />
        </FieldRow>
      </div>
      <div className="grid gap-4">
        <PromptField
          label="Describe prompt"
          source={sourceFor(settings, 'ai', 'describe_system_prompt')}
          value={form.ai.describe_system_prompt}
          onChange={value => setField('ai', 'describe_system_prompt', value)}
        />
        <PromptField
          label="Ask prompt"
          source={sourceFor(settings, 'ai', 'ask_system_prompt')}
          value={form.ai.ask_system_prompt}
          onChange={value => setField('ai', 'ask_system_prompt', value)}
        />
        <PromptField
          label="Alert explanation prompt"
          source={sourceFor(settings, 'ai', 'alert_explanation_system_prompt')}
          value={form.ai.alert_explanation_system_prompt}
          onChange={value => setField('ai', 'alert_explanation_system_prompt', value)}
        />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <SwitchRow
          label="Search embeddings"
          source={sourceFor(settings, 'ai', 'search_embeddings_enabled')}
          checked={form.ai.search_embeddings_enabled}
          onChange={value => setField('ai', 'search_embeddings_enabled', value)}
        />
        <FieldRow label="Embedding dimensions">
          <Input value={form.ai.search_embedding_dimensions} disabled readOnly />
        </FieldRow>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FieldRow
          label="Embedding provider"
          source={sourceFor(settings, 'ai', 'search_embedding_provider')}
        >
          <Input
            value={form.ai.search_embedding_provider}
            onChange={event =>
              setField('ai', 'search_embedding_provider', event.target.value)
            }
          />
        </FieldRow>
        <FieldRow
          label="Embedding model"
          source={sourceFor(settings, 'ai', 'search_embedding_model')}
        >
          <Input
            value={form.ai.search_embedding_model}
            onChange={event =>
              setField('ai', 'search_embedding_model', event.target.value)
            }
          />
        </FieldRow>
      </div>
      <FieldRow
        label="Embedding API key"
        source={sourceFor(settings, 'ai', 'search_embedding_api_key_configured' as never)}
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="password"
            value={secretDrafts.search_embedding_api_key}
            onChange={event =>
              setSecretDrafts(current => ({
                ...current,
                search_embedding_api_key: event.target.value,
              }))
            }
            placeholder={
              form.ai.search_embedding_api_key_configured
                ? 'Configured - leave blank to keep'
                : 'Not configured'
            }
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onClearSecret('ai', 'search_embedding_api_key')}
            disabled={resetting}
          >
            Clear
          </Button>
        </div>
      </FieldRow>
    </SectionCard>
  )
}
