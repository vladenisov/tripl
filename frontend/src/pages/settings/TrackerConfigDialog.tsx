import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { ApiError } from '@/api/client'
import { trackerConfigApi } from '@/api/trackerConfig'
import { useAuth } from '@/components/auth-context'
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
import { getErrorMessage } from '@/lib/utils'
import type { ProjectTrackerConfig, ProjectTrackerConfigUpdate } from '@/types'

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
  const { data: config } = useQuery({
    queryKey: ['trackerConfig', slug],
    queryFn: () => trackerConfigApi.get(slug),
    enabled: open,
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Implementation tracker</DialogTitle>
        </DialogHeader>
        {config ? (
          <TrackerConfigForm slug={slug} config={config} onClose={() => onOpenChange(false)} />
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
  const canEdit = user?.role === 'owner'

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

  const saveMut = useMutation({
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
      onSubmit={(event) => {
        event.preventDefault()
        if (canEdit) saveMut.mutate()
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
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor={projectKeyId}>Project key</Label>
          <Input
            id={projectKeyId}
            value={projectKey}
            onChange={(event) => setProjectKey(event.target.value)}
            placeholder="ENG"
            disabled={!canEdit}
          />
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
          />
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
