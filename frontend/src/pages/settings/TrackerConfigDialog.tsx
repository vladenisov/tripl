import { useId, useState } from 'react'
import { FieldError } from '@/components/forms/FieldError'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ApiError } from '@/api/client'
import { trackerConfigApi } from '@/api/trackerConfig'
import { useAuth } from '@/components/auth-context'
import { ErrorState } from '@/components/error-state'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { trackerConfigKey } from '@/lib/queryKeys'
import { getErrorMessage } from '@/lib/utils'
import type { ProjectTrackerConfig, ProjectTrackerConfigUpdate } from '@/types'
import { isOwner } from '@/lib/permissions'

const DEFAULT_ISSUE_TYPE = 'Task'

/** Decode a failed PATCH: 403 (non-owner) gets a plain-language line; 422 and
 * everything else falls back to the client's already-formatted message (which
 * expands FastAPI validation `detail` arrays into "base_url: …"-style text). */
function describeTrackerError(error: unknown): string {
  if (error instanceof ApiError && error.status === 403) {
    return 'Only project owners can change the tracker connection.'
  }
  return getErrorMessage(error)
}

type TrackerField = 'baseUrl' | 'projectKey' | 'authEmail'

interface TrackerFormValues {
  enabled: boolean
  baseUrl: string
  projectKey: string
  authEmail: string
}

// The backend's own rules (alerting_validation.py): `_validate_https_url` wants
// an https URL with a host and no whitespace, `_JIRA_PROJECT_KEY_RE` an
// uppercase key after it upper-cases the input, and `validate_email_address` an
// address. Checked here so a typo is named beside its field instead of coming
// back as one 422 line.
const JIRA_PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{1,31}$/
const REQUIRED_WHEN_ENABLED = 'Required while the tracker is enabled.'
const CANNOT_CLEAR = 'A saved value cannot be cleared; enter a new one.'

/**
 * What the form would save wrong, per field (PLAN-21).
 *
 * The backend validates every field it is SENT and rejects an empty one ("Jira
 * base_url is required"), but it does not require any of them to exist: a
 * tracker can be enabled with no project key and only fail later, in the merge
 * worker, where nobody sees it. So: a field that is filled must be valid; an
 * enabled tracker needs all three; a disabled one may stay half-filled, because
 * blank fields are simply not sent (see `trackerPatch`). What cannot be done is
 * blanking a field that has a saved value — the PATCH has no way to clear it.
 */
function trackerConfigErrors(
  values: TrackerFormValues,
  saved: ProjectTrackerConfig,
): Partial<Record<TrackerField, string>> {
  const errors: Partial<Record<TrackerField, string>> = {}
  const blank = (savedValue: string) =>
    savedValue.trim() !== '' ? CANNOT_CLEAR : values.enabled ? REQUIRED_WHEN_ENABLED : null

  const baseUrl = values.baseUrl.trim()
  if (baseUrl === '') {
    const message = blank(saved.base_url)
    if (message) errors.baseUrl = message
  } else {
    let parsed: URL | null
    try {
      parsed = /\s/.test(baseUrl) ? null : new URL(baseUrl)
    } catch {
      parsed = null
    }
    if (!parsed || parsed.protocol !== 'https:' || !parsed.hostname) {
      errors.baseUrl = 'Enter an https URL, such as https://acme.atlassian.net.'
    }
  }

  const projectKey = values.projectKey.trim()
  if (projectKey === '') {
    const message = blank(saved.project_key)
    if (message) errors.projectKey = message
  } else if (!JIRA_PROJECT_KEY_RE.test(projectKey.toUpperCase())) {
    errors.projectKey = 'Use 2–32 letters, digits or underscores, starting with a letter (e.g. ENG).'
  }

  const email = values.authEmail.trim()
  if (email === '') {
    const message = blank(saved.auth_email)
    if (message) errors.authEmail = message
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.authEmail = 'Enter an email address.'
  }
  return errors
}

/**
 * The PATCH body: only what changed, and never an empty string. The backend
 * validates every field present and refuses a blank one, so sending the whole
 * form turned "save the issue type of a parked, half-filled connection" into a
 * 422 about a base URL nobody touched.
 */
function trackerPatch(
  values: TrackerFormValues & { issueType: string; apiToken: string },
  saved: ProjectTrackerConfig,
): ProjectTrackerConfigUpdate {
  const patch: ProjectTrackerConfigUpdate = {}
  if (values.enabled !== saved.enabled) patch.enabled = values.enabled
  const text: Array<['base_url' | 'project_key' | 'auth_email' | 'issue_type', string]> = [
    ['base_url', values.baseUrl],
    ['project_key', values.projectKey],
    ['auth_email', values.authEmail],
    ['issue_type', values.issueType.trim() || DEFAULT_ISSUE_TYPE],
  ]
  for (const [key, raw] of text) {
    const value = raw.trim()
    if (value !== '' && value !== saved[key]) {
      patch[key] = value
    }
  }
  // Only when the user actually typed one — otherwise omitted, so the stored
  // token is preserved (an empty string would clear it).
  if (values.apiToken.trim() !== '') patch.api_token = values.apiToken
  return patch
}

interface TrackerConfigDialogProps {
  slug: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Owner-gated dialog to configure the project's implementation-tracker (Jira)
 * connection. A sibling of the branch merge-policy dialog: same surface (the
 * branches settings tab), same Dialog/primitive styling.
 */
export function TrackerConfigDialog({ slug, open, onOpenChange }: TrackerConfigDialogProps) {
  const configQuery = useQuery({
    queryKey: trackerConfigKey(slug),
    queryFn: () => trackerConfigApi.get(slug),
    enabled: open,
    // Rendered in the dialog with a retry, instead of "Loading tracker…"
    // forever (PLAN-21).
    meta: SILENT_ERROR_META,
  })
  const config = configQuery.data

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Implementation tracker</DialogTitle>
        </DialogHeader>
        {config ? (
          <TrackerConfigForm slug={slug} config={config} onClose={() => onOpenChange(false)} />
        ) : configQuery.isError ? (
          <ErrorState
            compact
            className="my-4"
            title="Could not load the tracker connection"
            error={configQuery.error}
            onRetry={() => void configQuery.refetch()}
          />
        ) : (
          <p className="py-4 text-body text-muted-foreground">Loading tracker…</p>
        )}
      </DialogContent>
    </Dialog>
  )
}

interface TrackerConfigFormProps {
  slug: string
  config: ProjectTrackerConfig
  onClose: () => void
}

function TrackerConfigForm({ slug, config, onClose }: TrackerConfigFormProps) {
  const qc = useQueryClient()
  const { user } = useAuth()
  // PATCH is owner-only on the backend; mirror the merge-policy / general
  // settings gate so non-owners get a read-only view instead of a 403.
  const canEdit = isOwner(user?.role)

  const enabledId = useId()
  const baseUrlId = useId()
  const projectKeyId = useId()
  const authEmailId = useId()
  const apiTokenId = useId()
  const issueTypeId = useId()

  const [enabled, setEnabled] = useState(config.enabled)
  const [baseUrl, setBaseUrl] = useState(config.base_url)
  const [projectKey, setProjectKey] = useState(config.project_key)
  const [authEmail, setAuthEmail] = useState(config.auth_email)
  const [issueType, setIssueType] = useState(config.issue_type || DEFAULT_ISSUE_TYPE)
  // The password field always starts empty: the raw token is never returned, so
  // a blank field means "keep the stored token".
  const [apiToken, setApiToken] = useState('')

  const errors = trackerConfigErrors({ enabled, baseUrl, projectKey, authEmail }, config)
  const invalid = Object.keys(errors).length > 0
  // Field errors show once the owner has tried to save, not while typing.
  const [attempted, setAttempted] = useState(false)
  const shown = attempted ? errors : {}
  const fieldProps = (field: TrackerField, errorId: string) =>
    shown[field]
      ? { 'aria-invalid': true as const, 'aria-describedby': errorId }
      : {}
  const baseUrlErrorId = useId()
  const projectKeyErrorId = useId()
  const authEmailErrorId = useId()

  const saveMut = useMutation({
    // Rendered inline below the fields.
    meta: SILENT_ERROR_META,
    mutationFn: () =>
      trackerConfigApi.update(
        slug,
        trackerPatch({ enabled, baseUrl, projectKey, authEmail, issueType, apiToken }, config),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: trackerConfigKey(slug) })
      // Clear the just-saved token so the field returns to its "leave blank to
      // keep" state and the raw value never lingers in the DOM.
      setApiToken('')
    },
  })

  const tokenPlaceholder = config.api_token_set
    ? 'Token stored — leave blank to keep'
    : 'Paste your Jira API token'

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        setAttempted(true)
        if (canEdit && !invalid) saveMut.mutate()
      }}
    >
      <div className="grid gap-4 py-4">
        <p className="text-body-sm text-muted-foreground">
          When enabled, merging a branch opens one Jira ticket for its added/changed events;
          closing the ticket marks those events implemented.
        </p>

        <div className="flex items-center justify-between gap-3">
          <div>
            <Label htmlFor={enabledId}>Enabled</Label>
            <p className="mt-1 text-body-sm text-muted-foreground">
              Open implementation tickets when branches merge.
            </p>
          </div>
          <Switch
            id={enabledId}
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={!canEdit}
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor={baseUrlId}>Base URL</Label>
          <Input
            id={baseUrlId}
            type="url"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="e.g. https://acme.atlassian.net"
            disabled={!canEdit}
            {...fieldProps('baseUrl', baseUrlErrorId)}
          />
          <FieldError id={baseUrlErrorId} message={shown.baseUrl} />
        </div>

        <div className="grid gap-2">
          <Label htmlFor={projectKeyId}>Project key</Label>
          <Input
            id={projectKeyId}
            value={projectKey}
            onChange={(event) => setProjectKey(event.target.value)}
            placeholder="e.g. ENG"
            disabled={!canEdit}
            {...fieldProps('projectKey', projectKeyErrorId)}
          />
          <FieldError id={projectKeyErrorId} message={shown.projectKey} />
        </div>

        <div className="grid gap-2">
          <Label htmlFor={authEmailId}>Auth email</Label>
          <Input
            id={authEmailId}
            type="email"
            value={authEmail}
            onChange={(event) => setAuthEmail(event.target.value)}
            placeholder="e.g. you@acme.com"
            disabled={!canEdit}
            {...fieldProps('authEmail', authEmailErrorId)}
          />
          <FieldError id={authEmailErrorId} message={shown.authEmail} />
        </div>

        <div className="grid gap-2">
          <Label htmlFor={apiTokenId}>API token</Label>
          <Input
            id={apiTokenId}
            type="password"
            autoComplete="off"
            value={apiToken}
            onChange={(event) => setApiToken(event.target.value)}
            placeholder={tokenPlaceholder}
            disabled={!canEdit}
          />
          <p className="text-body-sm text-muted-foreground">
            {config.api_token_set
              ? 'A token is stored. Leave this blank to keep it, or paste a new one to replace it.'
              : 'Create an API token in your Jira account settings.'}
          </p>
        </div>

        <div className="grid gap-2">
          <Label htmlFor={issueTypeId}>Issue type</Label>
          <Input
            id={issueTypeId}
            value={issueType}
            onChange={(event) => setIssueType(event.target.value)}
            placeholder={DEFAULT_ISSUE_TYPE}
            disabled={!canEdit}
          />
        </div>

        {saveMut.isSuccess && (
          <p className="text-body" style={{ color: 'var(--success)' }}>
            Tracker configuration saved.
          </p>
        )}
        {saveMut.isError && (
          <p className="text-body" style={{ color: 'var(--danger)' }}>
            {describeTrackerError(saveMut.error)}
          </p>
        )}
        {!canEdit && (
          <p className="text-body-sm text-muted-foreground">
            Only project owners can edit the tracker connection.
          </p>
        )}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {canEdit ? 'Cancel' : 'Close'}
        </Button>
        {canEdit && (
          <Button type="submit" disabled={saveMut.isPending}>
            Save
          </Button>
        )}
      </DialogFooter>
    </form>
  )
}
