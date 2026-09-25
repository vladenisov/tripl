import { useId, useState } from 'react'
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

/**
 * What the form would save wrong, per field (PLAN-21). The backend accepts any
 * string, so a typo in the base URL or an enabled tracker with no project key
 * used to save cleanly and only fail later, in the merge worker, where nobody
 * sees it. An empty field is fine while the tracker is off: an owner may park
 * a half-filled connection.
 */
function trackerConfigErrors(values: {
  enabled: boolean
  baseUrl: string
  projectKey: string
  authEmail: string
}): Partial<Record<TrackerField, string>> {
  const errors: Partial<Record<TrackerField, string>> = {}
  const baseUrl = values.baseUrl.trim()
  if (baseUrl !== '') {
    let parsed: URL | null
    try {
      parsed = new URL(baseUrl)
    } catch {
      parsed = null
    }
    if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      errors.baseUrl = 'Enter a full URL, such as https://acme.atlassian.net.'
    }
  } else if (values.enabled) {
    errors.baseUrl = 'Required while the tracker is enabled.'
  }
  if (values.enabled && values.projectKey.trim() === '') {
    errors.projectKey = 'Required while the tracker is enabled.'
  }
  const email = values.authEmail.trim()
  if (email !== '' && !/^[^\s@]+@[^\s@]+$/.test(email)) {
    errors.authEmail = 'Enter an email address.'
  } else if (email === '' && values.enabled) {
    errors.authEmail = 'Required while the tracker is enabled.'
  }
  return errors
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
    queryKey: ['trackerConfig', slug],
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
          <p className="py-4 text-sm text-muted-foreground">Loading tracker…</p>
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

  const errors = trackerConfigErrors({ enabled, baseUrl, projectKey, authEmail })
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
    mutationFn: () => {
      const patch: ProjectTrackerConfigUpdate = {
        enabled,
        base_url: baseUrl.trim(),
        project_key: projectKey.trim(),
        auth_email: authEmail.trim(),
        issue_type: issueType.trim() || DEFAULT_ISSUE_TYPE,
      }
      // Only send api_token when the user actually typed one — otherwise omit it
      // so the stored token is preserved (the backend rejects an empty string).
      if (apiToken.trim() !== '') {
        patch.api_token = apiToken
      }
      return trackerConfigApi.update(slug, patch)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['trackerConfig', slug] })
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
        <p className="text-xs text-muted-foreground">
          When enabled, merging a branch opens one Jira ticket for its added/changed events;
          closing the ticket marks those events implemented.
        </p>

        <div className="flex items-center justify-between gap-3">
          <div>
            <Label htmlFor={enabledId}>Enabled</Label>
            <p className="mt-1 text-xs text-muted-foreground">
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
            placeholder="https://acme.atlassian.net"
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
            placeholder="ENG"
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
            placeholder="you@acme.com"
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
          <p className="text-xs text-muted-foreground">
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
          <p className="text-sm" style={{ color: 'var(--success)' }}>
            Tracker configuration saved.
          </p>
        )}
        {saveMut.isError && (
          <p className="text-sm" style={{ color: 'var(--danger)' }}>
            {describeTrackerError(saveMut.error)}
          </p>
        )}
        {!canEdit && (
          <p className="text-xs text-muted-foreground">
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

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null
  return (
    <p id={id} className="text-xs" style={{ color: 'var(--danger)' }}>
      {message}
    </p>
  )
}
