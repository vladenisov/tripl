import { useRef, useState, type ComponentProps } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Eye, EyeOff } from 'lucide-react'

import { alertingApi } from '@/api/alerting'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useDirtySinceOpen, useUnsavedDialogGuard } from '@/hooks/useUnsavedChangesGuard'
import { FieldError } from '@/components/forms/FieldError'
import { examplePlaceholder } from '@/components/forms/placeholders'
import { REQUIRED_MESSAGE, focusFirstInvalid, missingSummary } from '@/components/forms/validation'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import type { AlertDestination } from '@/types'

import { invalidateAlertingConfig } from './alertingCache'
import { CHANNEL_META } from './channelMeta'
import { defaultDestinationForm, type DestinationChannel, type DestinationFormState } from './constants'
import { DeliveryScheduleField } from './DeliveryScheduleField'
import { resolveScheduleTimezone } from './deliverySchedule'
import {
  DESTINATION_FIELD_LABELS,
  DESTINATION_FIELD_MAX_LENGTH,
  destinationFormProblems,
  destinationFormToPayload,
  destinationToForm,
} from './destinationForm'
import { fieldErrorProps, splitApiFieldErrors } from './fieldErrors'

/** What the dialog was opened for. */
export type DestinationDialogTarget =
  | {
      mode: 'create'
      type: DestinationChannel
      /**
       * Hand the new destination straight on to a rule form — guided setup's
       * step 2 → 3. Decided by whoever OPENED the dialog, not on success: an
       * editor adding a second channel from Destinations is not in a setup
       * flow and must stay where they are (ALR-9).
       */
      handOffToRule: boolean
    }
  | { mode: 'edit'; destination: AlertDestination }

interface DestinationDialogProps {
  slug: string
  target: DestinationDialogTarget
  /** Read for its timezone, so the schedule copy names the clock it runs on. */
  project: { timezone?: string } | undefined
  isDemo: boolean
  onClose: () => void
  onCreated: (created: AlertDestination, handOffToRule: boolean) => void
}

// A password manager treats "a text field, then a password field" as a login
// form: it offers to autofill the operator's saved tripl password into a webhook
// or token box, and to "save a password" under the destination's name (ALR-25).
// `new-password` is the one autocomplete value browsers honour for "not mine",
// and the two data attributes are 1Password's and LastPass's own opt-outs.
const SECRET_INPUT_PROPS = {
  autoComplete: 'new-password',
  'data-1p-ignore': true,
  'data-lpignore': 'true',
} as const

/**
 * A write-only credential: masked, with a toggle to check what was typed.
 *
 * The webhook Target URL is stored encrypted exactly like a token
 * (`target_url_set`), but it was a plain text box echoing the secret on screen
 * while being typed (ALR-25).
 */
function SecretInput({ label, ...props }: ComponentProps<typeof Input> & { label: string }) {
  const [shown, setShown] = useState(false)
  return (
    <div className="flex gap-1">
      <Input {...props} {...SECRET_INPUT_PROPS} type={shown ? 'text' : 'password'} />
      <IconButton
        type="button"
        variant="ghost"
        className="shrink-0"
        label={`${shown ? 'Hide' : 'Show'} ${label}`}
        aria-pressed={shown}
        onClick={() => setShown(current => !current)}
      >
        {shown ? <EyeOff aria-hidden="true" className="h-4 w-4" /> : <Eye aria-hidden="true" className="h-4 w-4" />}
      </IconButton>
    </div>
  )
}

/** The inputs each channel renders — what a server error may be attached to. */
const CHANNEL_FIELDS: Record<DestinationFormState['type'], readonly (keyof DestinationFormState)[]> = {
  slack: ['webhook_url'],
  telegram: ['bot_token', 'chat_id'],
  webhook: ['target_url', 'webhook_header_name', 'webhook_header_value'],
  email: ['email_recipients', 'email_from_address', 'email_subject_template'],
  jira: ['jira_base_url', 'jira_auth_email', 'jira_api_token', 'jira_project_key', 'jira_issue_type'],
  linear: ['linear_api_key', 'linear_team_id', 'linear_state_id', 'linear_label_ids'],
  demo_sink: [],
}

/**
 * The destination create/edit form, lifted out of the page (ALR-42).
 *
 * It lived inline in ProjectAlertingTab beside the inbox logic, with create and
 * update building their bodies forty lines apart and disagreeing about which
 * fields went on the wire — which is how create came to send `chat_id: ''` for
 * every channel (ALR-1). Both now go through `destinationFormToPayload`.
 *
 * Mounted per opening (the page keys it), so a new opening starts with a fresh
 * form AND fresh mutations: a failed create followed by Cancel no longer
 * reopens on the next channel with the old error already showing (ALR-7).
 */
export function DestinationDialog({
  slug,
  target,
  project,
  isDemo,
  onClose,
  onCreated,
}: DestinationDialogProps) {
  const qc = useQueryClient()
  const existing = target.mode === 'edit' ? target.destination : null
  const [form, setForm] = useState<DestinationFormState>(() =>
    existing ? destinationToForm(existing) : defaultDestinationForm(target.mode === 'create' ? target.type : 'slack'),
  )
  const [removeWebhookHeader, setRemoveWebhookHeader] = useState(false)
  const [scheduleValid, setScheduleValid] = useState(true)
  // Client-side problems are named once a submit has been tried, not while the
  // form is being filled in: a pair that is half-typed is not yet a mistake.
  const [submitAttempted, setSubmitAttempted] = useState(false)

  const createMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: () => alertingApi.createDestination(slug, destinationFormToPayload(form, null)),
    onSuccess: created => {
      invalidateAlertingConfig(qc, slug)
      onCreated(created, target.mode === 'create' && target.handOffToRule)
    },
  })
  const updateMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: (destination: AlertDestination) =>
      alertingApi.updateDestination(
        slug,
        destination.id,
        destinationFormToPayload(form, destination, { removeWebhookHeader }),
      ),
    onSuccess: () => {
      invalidateAlertingConfig(qc, slug)
      onClose()
    },
  })
  const mutation = existing ? updateMut : createMut

  // Same as the rule dialog (ALR-17): a close that would drop typed-in
  // credentials or templates asks first.
  const guard = useUnsavedDialogGuard(useDirtySinceOpen(true, { form, removeWebhookHeader }))
  const requestClose = () => guard.requestClose(onClose)

  const problems = destinationFormProblems(form, existing, { removeWebhookHeader })
  const server = splitApiFieldErrors(
    mutation.error,
    ['name', 'delivery_schedule_cron', ...CHANNEL_FIELDS[form.type]],
    DESTINATION_FIELD_LABELS,
  )
  // Secrets are required where nothing is stored yet — except on a demo
  // workspace, whose disabled Slack example has no webhook and must stay
  // renameable (ALR-2).
  const secretRequired = (isSet: boolean | undefined) => !existing || (!isSet && !isDemo)
  // What the form refuses to send empty, per channel. The fields that are
  // pre-filled and not secret stay required in edit mode too: an emptied Base
  // URL used to be sent as "absent", so Save "succeeded" and quietly kept the
  // old value (ALR-26). Checked here and named inline, not by the browser's
  // `required` bubble, which flagged the first empty field only (AL-28).
  const requiredFields: readonly (keyof DestinationFormState)[] = [
    'name',
    ...({
      slack: secretRequired(existing?.webhook_set) ? ['webhook_url' as const] : [],
      telegram: [
        ...(secretRequired(existing?.bot_token_set) ? ['bot_token' as const] : []),
        'chat_id' as const,
      ],
      webhook: secretRequired(existing?.target_url_set) ? ['target_url' as const] : [],
      email: ['email_recipients' as const],
      jira: [
        'jira_base_url' as const,
        'jira_auth_email' as const,
        ...(secretRequired(existing?.jira_api_token_set) ? ['jira_api_token' as const] : []),
        'jira_project_key' as const,
      ],
      linear: [
        ...(secretRequired(existing?.linear_api_key_set) ? ['linear_api_key' as const] : []),
        'linear_team_id' as const,
      ],
      demo_sink: [],
    } satisfies Record<DestinationFormState['type'], (keyof DestinationFormState)[]>)[form.type],
  ]
  const missing = requiredFields.filter(field => !String(form[field] ?? '').trim())
  const errorFor = (field: keyof DestinationFormState) =>
    (submitAttempted ? problems[field] ?? (missing.includes(field) ? REQUIRED_MESSAGE : undefined) : undefined)
    ?? server.fields[field]

  const formRef = useRef<HTMLFormElement>(null)
  const submit = () => {
    setSubmitAttempted(true)
    if (!scheduleValid || missing.length > 0 || Object.keys(problems).length > 0) {
      // Only the body scrolls (AL-4): take the reader to the first field the
      // refusal highlighted instead of leaving it below the fold.
      requestAnimationFrame(() => {
        if (formRef.current) focusFirstInvalid(formRef.current)
      })
      return
    }
    if (existing) updateMut.mutate(existing)
    else createMut.mutate()
  }
  const set = <K extends keyof DestinationFormState>(field: K, value: DestinationFormState[K]) =>
    setForm(current => ({ ...current, [field]: value }))

  const channelLabel = (type: DestinationFormState['type']) =>
    type === 'demo_sink'
      ? 'Local sink'
      : CHANNEL_META.find(meta => meta.channel === type)?.label ?? type

  /** One text input with its label, limits and error, by payload field. */
  const textField = (
    field: keyof typeof DESTINATION_FIELD_MAX_LENGTH | 'email_recipients',
    id: string,
    label: string,
    { optional = false, ...extra }: Partial<ComponentProps<typeof Input>> & { optional?: boolean } = {},
  ) => {
    const error = errorFor(field)
    return (
      <div className="grid gap-2">
        <Label htmlFor={id} optional={optional}>{label}</Label>
        <Input
          id={id}
          autoComplete="off"
          maxLength={field === 'email_recipients' ? undefined : DESTINATION_FIELD_MAX_LENGTH[field]}
          value={form[field]}
          onChange={event => set(field, event.target.value)}
          aria-required={requiredFields.includes(field) || undefined}
          {...fieldErrorProps(id, error)}
          {...extra}
        />
        <FieldError inputId={id} message={error} />
      </div>
    )
  }

  /** One write-only credential, by payload field. */
  const secretField = (
    field: 'webhook_url' | 'bot_token' | 'target_url' | 'webhook_header_value' | 'jira_api_token' | 'linear_api_key',
    id: string,
    label: string,
    { placeholder, optional = false }: { placeholder: string; optional?: boolean },
  ) => {
    const error = errorFor(field)
    return (
      <div className="grid gap-2">
        <Label htmlFor={id} optional={optional}>{label}</Label>
        <SecretInput
          id={id}
          label={label}
          placeholder={placeholder}
          value={form[field]}
          onChange={event => set(field, event.target.value)}
          aria-required={requiredFields.includes(field) || undefined}
          {...fieldErrorProps(id, error)}
        />
        <FieldError inputId={id} message={error} />
      </div>
    )
  }

  // One announced line for the whole form. The per-input messages are not live
  // regions, so without this a rejected submit would change nothing a screen
  // reader says.
  const hasFieldErrors = [...CHANNEL_FIELDS[form.type], 'name' as const, 'delivery_schedule_cron' as const]
    .some(field => !!errorFor(field))
  const alertMessage =
    submitAttempted && !scheduleValid
      ? 'Fix the delivery schedule above before saving — the cadence on screen is not valid yet.'
      : server.message
        ?? (submitAttempted ? missingSummary(missing.map(field => DESTINATION_FIELD_LABELS[field] ?? field)) : null)
        ?? (hasFieldErrors ? 'Check the highlighted fields.' : null)

  return (
    <>
      {guard.dialog}
      <Dialog open onOpenChange={open => { if (!open) requestClose() }}>
        <DialogContent className="max-w-lg">
          {/* `noValidate`: required fields are named inline and in the line
              above the actions, not by a browser bubble (AL-28). Only the body
              scrolls; the title and the actions stay on screen (AL-4). */}
          <form
            ref={formRef}
            noValidate
            className="flex min-h-0 flex-col gap-4"
            onSubmit={event => { event.preventDefault(); submit() }}
          >
            <DialogHeader>
              <DialogTitle>
                {existing ? 'Edit destination' : `New ${channelLabel(form.type)} destination`}
              </DialogTitle>
            </DialogHeader>
            <DialogBody className="grid gap-4 py-1">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {textField('name', 'dest-name', 'Name')}
                <div className="grid gap-2">
                  <Label htmlFor="dest-channel">Channel</Label>
                  <Select
                    value={form.type}
                    onValueChange={value => {
                      // The last attempt's errors belong to the channel it was
                      // for: kept, a Slack 422 on `webhook_url` resurfaced as
                      // "Webhook URL: …" on a Telegram form (ALR-7).
                      createMut.reset()
                      setSubmitAttempted(false)
                      setForm(current => ({
                        ...defaultDestinationForm(value as DestinationChannel),
                        name: current.name,
                        enabled: current.enabled,
                        delivery_schedule_cron: current.delivery_schedule_cron,
                      }))
                    }}
                    disabled={!!existing}
                  >
                    <SelectTrigger id="dest-channel"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {CHANNEL_META.map(meta => (
                        <SelectItem key={meta.channel} value={meta.channel}>{meta.label}</SelectItem>
                      ))}
                      {/* Never offered for creation — the seeder makes it — but
                          an edit of one must still name it rather than render
                          a blank trigger (ALR-2). */}
                      {form.type === 'demo_sink' && (
                        <SelectItem value="demo_sink">{channelLabel('demo_sink')}</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {form.type === 'slack' && secretField('webhook_url', 'dest-webhook-url', 'Webhook URL', {
                placeholder: existing?.webhook_set ? 'Leave empty to keep current webhook' : examplePlaceholder('https://hooks.slack.com/...'),
              })}

              {form.type === 'telegram' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {secretField('bot_token', 'dest-bot-token', 'Bot token', {
                    placeholder: existing?.bot_token_set ? 'Leave empty to keep current token' : examplePlaceholder('123456:ABC...'),
                  })}
                  {textField('chat_id', 'dest-chat-id', 'Chat ID')}
                </div>
              )}

              {form.type === 'webhook' && (
                <div className="grid gap-3">
                  {secretField('target_url', 'dest-target-url', 'Target URL', {
                    placeholder: existing?.target_url_set ? 'Leave empty to keep current URL' : examplePlaceholder('https://example.com/webhook'),
                  })}
                  {removeWebhookHeader ? (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed p-3 text-body-sm text-muted-foreground">
                      <span role="status">
                        The secret header {existing?.webhook_header_name ? `"${existing.webhook_header_name}" ` : ''}will be removed on save.
                      </span>
                      <Button type="button" variant="outline" size="sm" onClick={() => setRemoveWebhookHeader(false)}>
                        Keep it
                      </Button>
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {textField('webhook_header_name', 'dest-header-name', 'Secret header name', {
                          placeholder: examplePlaceholder('Authorization'),
                          optional: true,
                        })}
                        {secretField('webhook_header_value', 'dest-header-value', 'Secret header value', {
                          placeholder: existing?.webhook_header_name ? 'Leave empty to keep current value' : examplePlaceholder('Bearer …'),
                          optional: true,
                        })}
                      </div>
                      {/* The stored value could not be removed at all: an empty
                          box means "keep it", and clearing only the name left
                          the encrypted value orphaned (ALR-24). */}
                      {existing?.webhook_header_name && (
                        <div>
                          <Button type="button" variant="outline" size="sm" onClick={() => setRemoveWebhookHeader(true)}>
                            Remove secret header
                          </Button>
                        </div>
                      )}
                    </>
                  )}
                  <p className="text-body-sm text-muted-foreground">
                    Alerts POST a JSON payload (project, rule, scan, message, items). The optional secret header is sent with every request — use it for auth (e.g. Authorization).
                  </p>
                </div>
              )}

              {form.type === 'email' && (
                <div className="grid gap-3">
                  {textField('email_recipients', 'dest-email-recipients', 'Recipients', {
                    placeholder: examplePlaceholder('alice@example.com', 'bob@example.com'),
                  })}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {textField('email_from_address', 'dest-email-from', 'From address', {
                      placeholder: `${examplePlaceholder('alerts@tripl.example')} or Tripl Alerts <alerts@tripl.example>`,
                      optional: true,
                    })}
                    {textField('email_subject_template', 'dest-email-subject', 'Subject template', {
                      placeholder: examplePlaceholder(`[\${project_name}] \${rule_name}`),
                      optional: true,
                    })}
                  </div>
                  <p className="text-body-sm text-muted-foreground">
                    SMTP settings (host/port/credentials) come from the instance config. Recipients are comma-separated. Subject supports {`\${project_name}`}, {`\${rule_name}`}, {`\${destination_name}`}, {`\${matched_count}`}.
                  </p>
                </div>
              )}

              {form.type === 'jira' && (
                <div className="grid gap-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {textField('jira_base_url', 'dest-jira-base-url', 'Base URL', {
                      placeholder: examplePlaceholder('https://acme.atlassian.net'),
                    })}
                    {textField('jira_auth_email', 'dest-jira-auth-email', 'Auth email', {
                      placeholder: examplePlaceholder('alice@example.com'),
                    })}
                  </div>
                  {secretField('jira_api_token', 'dest-jira-api-token', 'API token', {
                    placeholder: existing?.jira_api_token_set ? 'Leave empty to keep current token' : 'Atlassian API token',
                  })}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {textField('jira_project_key', 'dest-jira-project-key', 'Project key', {
                      placeholder: examplePlaceholder('ENG'),
                      onChange: event => set('jira_project_key', event.target.value.toUpperCase()),
                    })}
                    {textField('jira_issue_type', 'dest-jira-issue-type', 'Issue type', { placeholder: examplePlaceholder('Task') })}
                  </div>
                  <p className="text-body-sm text-muted-foreground">
                    Each delivery opens a new issue in the project via Jira REST API v3 with Basic auth (email + API token). Body is rendered as ADF.
                  </p>
                </div>
              )}

              {form.type === 'linear' && (
                <div className="grid gap-3">
                  {secretField('linear_api_key', 'dest-linear-api-key', 'API key', {
                    placeholder: existing?.linear_api_key_set ? 'Leave empty to keep current key' : examplePlaceholder('lin_api_…'),
                  })}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {textField('linear_team_id', 'dest-linear-team-id', 'Team ID', {
                      placeholder: 'Team UUID or short ID',
                    })}
                    {textField('linear_state_id', 'dest-linear-state-id', 'State ID', {
                      placeholder: 'State UUID',
                      optional: true,
                    })}
                  </div>
                  {textField('linear_label_ids', 'dest-linear-label-ids', 'Label IDs', {
                    placeholder: `Comma-separated, ${examplePlaceholder('label-1, label-2')}`,
                    optional: true,
                  })}
                  <p className="text-body-sm text-muted-foreground">
                    Each delivery opens a new issue in the team via Linear's GraphQL <code>issueCreate</code>. Use API key from Linear settings → API.
                  </p>
                </div>
              )}

              {/* A local sink has no channel settings: it records deliveries on
                  this instance and sends nothing, so name, switch and schedule
                  are the whole form. It used to fall through to the Linear
                  fields, whose required API key blocked every save (ALR-2). */}
              {form.type === 'demo_sink' && (
                <p className="text-body-sm text-muted-foreground">
                  A local sink records deliveries on this instance and sends nothing, so it has no channel settings.
                </p>
              )}

              <DeliveryScheduleField
                value={form.delivery_schedule_cron}
                onChange={cron => set('delivery_schedule_cron', cron)}
                onValidityChange={setScheduleValid}
                projectTimezone={resolveScheduleTimezone(project, existing)}
                nextDigestAt={existing?.next_digest_at}
                serverError={server.fields.delivery_schedule_cron}
              />

              <label className="flex items-center gap-2 text-body">
                <Checkbox
                  checked={form.enabled}
                  onCheckedChange={checked => set('enabled', !!checked)}
                />
                Destination enabled
              </label>

              {alertMessage && (
                <p role="alert" className="text-body text-destructive">{alertMessage}</p>
              )}
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={requestClose}>Cancel</Button>
              <Button type="submit" disabled={mutation.isPending}>
                {existing ? 'Save' : 'Create'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
