import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { invitationsApi, type Invitation, type InvitationCreated } from '@/api/invitations'
import { usersApi } from '@/api/users'
import { useAuth } from '@/components/auth-context'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { UserAvatar } from '@/components/ui/user-avatar'
import { useConfirm } from '@/hooks/useConfirm'
import { useCopyToClipboard } from '@/hooks/useCopyToClipboard'
import { NativeSelect, TextInput } from '@/components/settings/kit'
import { ROLE_OPTIONS, type Role, type UserListItem } from '@/types'
import { formatIsoDate } from '@/lib/datetime'
import { getErrorMessage } from '@/lib/utils'
import { isOwner as isOwnerRole } from '@/lib/permissions'
import { invitationsKey, usersKey } from '@/lib/queryKeys'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'

function roleChip(role: Role) {
  return ROLE_OPTIONS.find((r) => r.value === role)?.chip ?? 'bg-muted text-muted-foreground'
}


/** What the Owner role hands over, said the same way wherever it is granted. */
const OWNER_POWERS =
  'Owners administer the whole instance: its settings and secrets, the audit log, every member’s role, and deleting any project.'

const ROLE_RANK: Readonly<Record<Role, number>> = { viewer: 0, editor: 1, owner: 2 }

function roleLabel(role: Role): string {
  return ROLE_OPTIONS.find((r) => r.value === role)?.label ?? role
}

/** How long the Copy button says "Copied" before it offers to copy again. */
const COPIED_RESET_MS = 2000

/**
 * Invite one person without opening the instance to the world.
 *
 * The redeem link is shown exactly once, right after minting: the server never
 * returns it again, so this is the only chance to copy it. That is deliberate —
 * SMTP is optional here, so handing the link over out of band is a first-class
 * path rather than a fallback.
 *
 * Because it is shown once, the panel stays until it is dismissed, and minting
 * another invite over a link nobody copied asks first: it used to be replaced
 * without a word, and the first link was gone for good (WS-21).
 */
function InviteMemberCard() {
  const qc = useQueryClient()
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('editor')
  const [minted, setMinted] = useState<InvitationCreated | null>(null)
  const [everCopied, setEverCopied] = useState(false)
  const linkRef = useRef<HTMLInputElement>(null)
  const { state: copyState, copy, reset: resetCopy } = useCopyToClipboard(linkRef)
  const { confirm, dialog } = useConfirm()

  // "Copied" is a moment, not a state: it went on saying so forever, so a
  // second click could not tell whether it had worked again.
  useEffect(() => {
    if (copyState !== 'copied') return
    const timer = window.setTimeout(resetCopy, COPIED_RESET_MS)
    return () => window.clearTimeout(timer)
  }, [copyState, resetCopy])

  const invitesQuery = useQuery({
    queryKey: invitationsKey(),
    queryFn: () => invitationsApi.list(),
  })
  const createMut = useMutation({
    // Rendered in the card (role="alert" below), so no toast as well.
    meta: SILENT_ERROR_META,
    mutationFn: () => invitationsApi.create(email.trim(), role),
    onSuccess: (created) => {
      setMinted(created)
      setEverCopied(false)
      resetCopy()
      setEmail('')
      qc.invalidateQueries({ queryKey: invitationsKey() })
    },
  })
  const revokeMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: (id: string) => invitationsApi.revoke(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: invitationsKey() }),
  })

  const handleRevoke = async (inv: Invitation) => {
    const ok = await confirm({
      title: 'Revoke invitation',
      message:
        `Revoke the invitation for ${inv.email}? Their link stops working immediately, and `
        + 'it cannot be reissued — you would have to create a new invite and send the new link.',
      confirmLabel: 'Revoke',
      variant: 'danger',
    })
    if (ok) revokeMut.mutate(inv.id)
  }

  const handleCopy = async (url: string) => {
    // No clipboard (a self-hosted instance on plain HTTP has none) or a refused
    // write selects the link instead: it is shown exactly once, so claiming a
    // copy that did not happen loses it outright.
    if (await copy(url)) setEverCopied(true)
  }

  // Dismiss loses the show-once link as surely as replacing it does, so it
  // asks the same question when nobody copied it.
  const handleDismiss = async () => {
    if (!minted) return
    if (!everCopied) {
      const ok = await confirm({
        title: 'Discard the uncopied invite link?',
        message:
          `The link for ${minted.invitation.email} has not been copied, and it cannot be shown `
          + 'again. Revoke it and create a new one if you need it.',
        confirmLabel: 'Discard link',
        variant: 'danger',
      })
      if (!ok) return
    }
    setMinted(null)
    resetCopy()
  }

  const handleCreate = async () => {
    if (!email.trim() || createMut.isPending) return
    if (minted && !everCopied) {
      const ok = await confirm({
        title: 'Replace the uncopied invite link?',
        message:
          `The link for ${minted.invitation.email} has not been copied, and it cannot be shown `
          + 'again. A new invite replaces it on this page. It keeps working until it expires or '
          + 'is revoked, unless the new invite is for the same address, which invalidates it.',
        confirmLabel: 'Create new link',
        variant: 'primary',
      })
      if (!ok) return
    }
    if (role === 'owner') {
      const ok = await confirm({
        title: 'Invite as Owner?',
        message:
          `${OWNER_POWERS} Whoever opens this link gets all of that, so send it only to `
          + `${email.trim()}.`,
        confirmLabel: 'Create owner invite',
        variant: 'danger',
      })
      if (!ok) return
    }
    createMut.mutate()
  }

  const invites = invitesQuery.data ?? []
  const acceptUrl = minted ? `${window.location.origin}${minted.accept_path}` : ''

  return (
    <div
      className="space-y-3 rounded-xl border p-4"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      {dialog}

      <div>
        <h3 className="text-body font-semibold">Invite a member</h3>
        <p className="mt-0.5 text-xs" style={{ color: 'var(--fg-subtle)' }}>
          Creates a single-use link for one address, at the role you pick. Use this instead of
          opening self-service registration.
        </p>
      </div>

      {/* The design system's Input and Button, not hand-styled elements: those
          were 32px and 24px tall, bordered differently from every other field,
          and had no focus ring at all for keyboard users (WS-20). */}
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void handleCreate()
        }}
      >
        <div className="min-w-[200px] flex-1">
          <label className="mb-1 block text-[11px]" htmlFor="invite-email">
            Email
          </label>
          {/* The kit field, like the role Select beside it, so the two
              controls of one row share a height and a theme (WS-20). */}
          <TextInput
            id="invite-email"
            type="email"
            required
            autoComplete="off"
            value={email}
            onChange={setEmail}
            placeholder="teammate@example.com"
          />
        </div>
        {/* The kit's Select, not a bare one. A native <select> keeps the
            platform's own widget: Chrome paints it with the UA's light
            background whatever `background` we hand it, so this was a pale box
            with a black chevron — the only unthemed control on the page
            (tripl-h3bb). */}
        <div className="w-32">
          <label className="mb-1 block text-[11px]" htmlFor="invite-role">
            Role
          </label>
          <NativeSelect
            id="invite-role"
            value={role}
            onChange={(next) => setRole(next as Role)}
            options={ROLE_OPTIONS}
            aria-describedby={role === 'owner' ? 'invite-owner-warning' : undefined}
          />
        </div>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={createMut.isPending || !email.trim()}
        >
          {createMut.isPending ? 'Creating…' : 'Create invite link'}
        </Button>
      </form>

      {/* An owner invite forwarded to the wrong person is a full takeover, so
          the role says what it grants before the link exists (WS-22). */}
      {role === 'owner' && (
        <p
          id="invite-owner-warning"
          className="m-0 text-caption"
          style={{ color: 'var(--warning)' }}
        >
          {OWNER_POWERS}
        </p>
      )}

      {createMut.isError && (
        <p role="alert" className="text-xs text-destructive">
          {getErrorMessage(createMut.error)}
        </p>
      )}

      {minted && (
        <div
          className="space-y-1.5 rounded-lg border p-3"
          style={{ borderColor: 'var(--border-strong)', background: 'var(--bg-elevated)' }}
        >
          <div className="flex items-start justify-between gap-2">
            <p className="text-xs font-medium">
              {roleLabel(minted.invitation.role)} invite link for {minted.invitation.email} — copy
              it now
            </p>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => void handleDismiss()}
            >
              Dismiss
            </Button>
          </div>
          <p className="text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
            This link is shown once and cannot be retrieved later. It expires{' '}
            {formatIsoDate(minted.expires_at)} and works a single time.
          </p>
          <div className="flex items-center gap-2">
            <Input
              ref={linkRef}
              readOnly
              aria-label="Invite link"
              value={acceptUrl}
              onFocus={(e) => e.currentTarget.select()}
              // A manual Ctrl/Cmd+C (the no-clipboard path) is a copy too;
              // otherwise every later invite warns about a link already copied.
              onCopy={() => setEverCopied(true)}
              className="mono h-8 flex-1 text-[11px]"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void handleCopy(acceptUrl)}
            >
              {copyState === 'copied' ? 'Copied' : 'Copy'}
            </Button>
          </div>
          {/* The label change alone was never announced. */}
          <p role="status" className="sr-only">
            {copyState === 'copied' ? 'Invite link copied to the clipboard.' : ''}
          </p>
          {copyState === 'failed' && (
            <p role="alert" className="text-[11px]" style={{ color: 'var(--danger)' }}>
              Couldn’t reach the clipboard. The link above is selected — press Ctrl/⌘+C to copy it.
            </p>
          )}
        </div>
      )}

      {invitesQuery.isError && (
        <ErrorState
          compact
          title="Couldn't load pending invitations"
          error={invitesQuery.error}
          onRetry={() => {
            void invitesQuery.refetch()
          }}
        />
      )}

      {invites.length > 0 && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium" style={{ color: 'var(--fg-subtle)' }}>
            Pending invitations
          </p>
          {invites.map((inv: Invitation) => (
            <div
              key={inv.id}
              className="flex items-center gap-2 border-b py-1.5 last:border-0"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              <span className="mono min-w-0 flex-1 truncate text-[11px]">{inv.email}</span>
              <span className="text-[10px]" style={{ color: 'var(--fg-faint)' }}>
                {roleLabel(inv.role)}
              </span>
              <span
                className="text-[10px]"
                style={{ color: inv.is_expired ? 'var(--danger)' : 'var(--fg-faint)' }}
              >
                {inv.is_expired ? 'expired' : `expires ${formatIsoDate(inv.expires_at)}`}
              </span>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => {
                  void handleRevoke(inv)
                }}
                disabled={revokeMut.isPending && revokeMut.variables === inv.id}
              >
                {revokeMut.isPending && revokeMut.variables === inv.id ? 'Revoking…' : 'Revoke'}
              </Button>
            </div>
          ))}
        </div>
      )}

      {revokeMut.isError && (
        <p role="alert" className="text-xs text-destructive">
          {getErrorMessage(revokeMut.error)}
        </p>
      )}
    </div>
  )
}

export default function UsersPage() {
  const qc = useQueryClient()
  const { user: currentUser } = useAuth()
  const isOwner = isOwnerRole(currentUser?.role)

  const { confirm, dialog } = useConfirm()

  const listQuery = useQuery({ queryKey: usersKey(), queryFn: () => usersApi.list() })
  const updateMut = useMutation({
    // The failure is shown on the row it belongs to, below.
    meta: SILENT_ERROR_META,
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      usersApi.updateRole(userId, role),
    onSuccess: () => qc.invalidateQueries({ queryKey: usersKey() }),
  })
  const users = listQuery.data ?? []

  /**
   * Picking from the Select used to PATCH at once, so a stray arrow key or
   * wheel on a focused select could demote an owner or grant Owner, with no
   * undo (WS-19). Granting Owner and every demotion now ask first; a
   * promotion short of Owner still applies directly.
   */
  const handleRoleChange = async (member: UserListItem, next: Role) => {
    if (next === member.role) return
    const who = member.name ?? member.email
    if (next === 'owner') {
      const ok = await confirm({
        title: `Make ${who} an owner?`,
        message: `${OWNER_POWERS} ${who} gets all of that as soon as you confirm.`,
        confirmLabel: 'Make owner',
        variant: 'danger',
      })
      if (!ok) return
    } else if (ROLE_RANK[next] < ROLE_RANK[member.role]) {
      const ok = await confirm({
        title: `Change ${who} to ${roleLabel(next)}?`,
        message:
          next === 'viewer'
            ? `${who} goes from ${roleLabel(member.role)} to Viewer and can no longer change anything in any project.`
            : `${who} goes from ${roleLabel(member.role)} to ${roleLabel(next)} and loses instance administration.`,
        confirmLabel: `Change to ${roleLabel(next)}`,
        variant: 'danger',
      })
      if (!ok) return
    }
    updateMut.mutate({ userId: member.id, role: next })
  }

  return (
    <div className="space-y-5">
      {dialog}
      {/* The section header above this (MembersSection) already says who is in
          the list. This used to restate it in a second vocabulary — "workspace"
          there, "instance" here — so two subtitles stacked directly on top of
          each other and a reader had to work out whether they named two
          different scopes (tripl-h3bb). All that is left is the one fact the
          header does not carry, and only for the people it applies to. */}
      {!isOwner && (
        <p className="text-sm" style={{ color: 'var(--fg-subtle)' }}>
          Only owners can change roles.
        </p>
      )}

      {isOwner && <InviteMemberCard />}

      <div
        className="overflow-hidden rounded-xl border"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        {listQuery.isLoading ? (
          <div aria-busy="true" aria-label="Loading users">
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                className="flex items-center gap-3 border-b px-4 py-2.5 last:border-0"
                style={{ borderColor: 'var(--border-subtle)' }}
              >
                <Skeleton className="h-7 w-7 shrink-0 rounded-full" />
                <div className="min-w-0 flex-1 space-y-1">
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-2.5 w-48" />
                </div>
                <Skeleton className="h-5 w-20 shrink-0" />
              </div>
            ))}
          </div>
        ) : listQuery.isError ? (
          /* Before the error branch existed, a failed fetch fell through to
             "No users yet." — a page that always contains at least the reader,
             claiming to be empty, with nowhere to retry. */
          <div className="p-4">
            <ErrorState
              compact
              title="Couldn't load users"
              error={listQuery.error}
              onRetry={() => {
                void listQuery.refetch()
              }}
            />
          </div>
        ) : users.length === 0 ? (
          <EmptyState size="sm" headingLevel={3} title="No users yet." />
        ) : (
          users.map((u: UserListItem) => (
            <div
              key={u.id}
              className="border-b px-4 py-2.5 last:border-0"
              style={{ borderColor: 'var(--border-subtle)' }}
            >
              <div className="flex items-center gap-3">
                {/* One avatar colour, the same token the shell and the settings
                    sidebar use. The hue used to be hashed from the user id, so
                    the person reading this page saw their own initials in pink
                    here and in blue in the sidebar footer 30px away — one account
                    rendered as two (tripl-h3bb). A hue carries no meaning worth
                    that. */}
                <UserAvatar name={u.name ?? u.email} size={28} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-body-sm font-medium leading-tight">
                    {u.name ?? u.email}
                  </div>
                  <div
                    className="mono truncate text-[11px] leading-tight"
                    style={{ color: 'var(--fg-subtle)' }}
                  >
                    {u.email}
                  </div>
                </div>
                {/* The bare "2026-08-19" was a date with no question attached —
                    joined? invited? last seen? — in a table that has no column
                    headers to answer it (tripl-h3bb). The format stays ISO: this
                    roster is read by whoever administers the instance, from
                    wherever they are, and formatIsoDate is the locale-proof one. */}
                <span
                  className="hidden w-36 shrink-0 text-right text-[11px] sm:block"
                  style={{ color: 'var(--fg-faint)' }}
                >
                  Joined <span className="mono">{formatIsoDate(u.created_at)}</span>
                </span>
                <div className="w-32 shrink-0 text-right">
                  {isOwner && u.id !== currentUser?.id ? (
                    <NativeSelect
                      value={u.role}
                      aria-label={`Role for ${u.name ?? u.email}`}
                      onChange={(next) => {
                        void handleRoleChange(u, next as Role)
                      }}
                      disabled={updateMut.isPending}
                      options={ROLE_OPTIONS}
                    />
                  ) : (
                    <span
                      className={`inline-flex items-center rounded px-2 py-0.5 text-[10px] font-medium ${roleChip(u.role)}`}
                    >
                      {ROLE_OPTIONS.find((r) => r.value === u.role)?.label ?? u.role}
                    </span>
                  )}
                </div>
              </div>
              {/* On the row it belongs to, naming the person: it used to sit
                  under the whole list, where it said nothing about whose role
                  had failed to change (WS-19). */}
              {updateMut.isError && updateMut.variables?.userId === u.id && (
                <p role="alert" className="m-0 mt-1.5 text-right text-xs text-destructive">
                  Could not change the role of {u.name ?? u.email}: {getErrorMessage(updateMut.error)}
                </p>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  )
}
