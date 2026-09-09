import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Loader2, MessageCircle, Trash2 } from 'lucide-react'
import { formatDateTime } from '@/lib/datetime'
import { isThreadUnanswered, threadStateLabel } from '@/components/commentThreadState'
import type { EventCommentAction, EventCommentStatus } from '@/types'

/**
 * The shape the thread renders. Both anchors — a photo and an event — keep
 * their comments in the same table, so this is the same row either way.
 */
export interface ThreadComment {
  id: string
  parent_id: string | null
  body: string
  created_at: string
  /** Null once the author's account is gone — the FK is SET NULL, because a
   *  deleted account must not take the discussion with it. */
  user_id?: string | null
  /** Resolution state, on the event thread only. The branch-review thread has
   *  no such columns, so these stay optional and the controls stay hidden
   *  unless a caller passes `onAction`. */
  status?: EventCommentStatus
  snoozed_until?: string | null
}

export interface CommentThreadProps {
  /** TanStack key for the list; posting and deleting invalidate it. */
  queryKey: readonly unknown[]
  list: () => Promise<ThreadComment[]>
  create: (body: string, parentId: string | null) => Promise<unknown>
  remove: (commentId: string) => Promise<unknown>
  heading?: string
  emptyText?: string
  /** Keeps the composer's label unique when two threads share a page. */
  composerId?: string
  className?: string
  /** Resolves a comment to a display name. A callback rather than a roster
   *  map, so the component stays free of the users query and each caller
   *  resolves however it already does. Without it the thread stays anonymous,
   *  which is what it was. */
  authorName?: (comment: ThreadComment) => string
  /** Fired after a comment is posted. The branch panel's demo scenario marks
   *  its last step here, and losing that would strand the chapter. */
  onCreated?: () => void
  /** Resolve / snooze / reopen one thread. Omitted by the branch-review thread,
   *  whose table has no resolution columns — without it no control renders and
   *  the component behaves exactly as it did. */
  onAction?: (
    commentId: string,
    action: EventCommentAction,
    snoozedUntil?: string,
  ) => Promise<unknown>
}

/** How long "snooze" parks a thread. A week is long enough to stop the nag and
 *  short enough that the question comes back while it still matters; the API
 *  takes any date, so a caller that wants a picker can have one later. */
const SNOOZE_DAYS = 7

/**
 * One comment thread, anchored by whatever the callbacks point at.
 *
 * The composer is a div with a button rather than a `<form>` on purpose. A
 * thread has to be mountable inside the event form, and a nested `<form>` is
 * invalid HTML — the browser drops the inner one, so the composer's submit
 * would save the EVENT instead of posting the comment. Nothing is lost: a
 * textarea never submitted on Enter anyway.
 */
export function CommentThread({
  queryKey,
  list,
  create,
  remove,
  heading = 'Comments',
  emptyText = 'No comments yet. Start the thread.',
  composerId = 'comment-body',
  className = 'flex h-full min-h-[400px] flex-col rounded-md border bg-card p-3',
  authorName,
  onCreated,
  onAction,
}: CommentThreadProps) {
  const queryClient = useQueryClient()
  const [body, setBody] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)

  const commentsQuery = useQuery({ queryKey: [...queryKey], queryFn: list })

  const createMut = useMutation({
    mutationFn: () => create(body.trim(), replyTo),
    onSuccess: () => {
      setBody('')
      setReplyTo(null)
      void queryClient.invalidateQueries({ queryKey: [...queryKey] })
      onCreated?.()
    },
  })

  const deleteMut = useMutation({
    mutationFn: (commentId: string) => remove(commentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...queryKey] })
    },
  })

  const actionMut = useMutation({
    mutationFn: ({
      commentId,
      action,
      snoozedUntil,
    }: {
      commentId: string
      action: EventCommentAction
      snoozedUntil?: string
    }) => onAction!(commentId, action, snoozedUntil),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...queryKey] })
      // The catalog's open-question count and filter read the same threads, so
      // a resolve here has to reach the list the user came from.
      void queryClient.invalidateQueries({ queryKey: ['events'] })
    },
  })

  // Array.isArray, not `?? []`: an error body or a stubbed fetch answering the
  // wrong shape must render an empty thread, not throw out of the page that
  // hosts it. This panel is a sidecar — it never gets to take the form down.
  const comments = Array.isArray(commentsQuery.data) ? commentsQuery.data : []
  const topLevel = comments.filter(comment => comment.parent_id === null)
  const repliesByParent = new Map<string, ThreadComment[]>()
  for (const comment of comments) {
    if (comment.parent_id) {
      const siblings = repliesByParent.get(comment.parent_id) ?? []
      siblings.push(comment)
      repliesByParent.set(comment.parent_id, siblings)
    }
  }

  const submit = () => {
    if (!body.trim() || createMut.isPending) return
    createMut.mutate()
  }

  return (
    <div className={className}>
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <MessageCircle className="h-4 w-4 text-muted-foreground" />
        {heading}
        <span className="text-xs font-normal text-muted-foreground">({comments.length})</span>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto pr-1 text-sm">
        {commentsQuery.isLoading ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : topLevel.length === 0 ? (
          <div className="text-xs text-muted-foreground">{emptyText}</div>
        ) : (
          topLevel.map(comment => (
            <CommentItem
              key={comment.id}
              comment={comment}
              replies={repliesByParent.get(comment.id) ?? []}
              onReply={() => setReplyTo(comment.id)}
              onDelete={id => deleteMut.mutate(id)}
              replyingTo={replyTo}
              authorName={authorName}
              onAction={
                onAction
                  ? (action, snoozedUntil) =>
                      actionMut.mutate({ commentId: comment.id, action, snoozedUntil })
                  : undefined
              }
              actionPending={actionMut.isPending}
            />
          ))
        )}
      </div>
      <div className="mt-3 flex flex-col gap-2 border-t pt-3">
        {replyTo && (
          <div className="flex items-center justify-between rounded bg-muted px-2 py-1 text-xs">
            <span>Replying to comment</span>
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setReplyTo(null)}
            >
              cancel
            </button>
          </div>
        )}
        <label htmlFor={composerId} className="sr-only">Write a comment</label>
        <textarea
          id={composerId}
          value={body}
          onChange={event => setBody(event.target.value)}
          // Enter belongs to the text — a comment is often several lines — so
          // the shortcut is the one every chat box uses.
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              submit()
            }
          }}
          placeholder="Write a comment…"
          className="min-h-[60px] w-full rounded-md border bg-background px-2 py-1 text-sm"
        />
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            onClick={submit}
            disabled={!body.trim() || createMut.isPending}
          >
            {createMut.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {replyTo ? 'Reply' : 'Comment'}
          </Button>
        </div>
      </div>
    </div>
  )
}

function CommentItem({
  comment,
  replies,
  onReply,
  onDelete,
  replyingTo,
  authorName,
  onAction,
  actionPending,
}: {
  comment: ThreadComment
  replies: ThreadComment[]
  onReply: () => void
  onDelete: (id: string) => void
  replyingTo: string | null
  authorName?: (comment: ThreadComment) => string
  onAction?: (action: EventCommentAction, snoozedUntil?: string) => void
  actionPending?: boolean
}) {
  const unanswered = isThreadUnanswered(comment)
  const stateLabel = threadStateLabel(comment)
  const snooze = () => {
    const until = new Date()
    until.setDate(until.getDate() + SNOOZE_DAYS)
    onAction?.('snooze', until.toISOString())
  }
  return (
    <div className="space-y-2">
      <div className="rounded-md border bg-muted/30 px-2 py-1.5">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {authorName ? `${authorName(comment)} · ` : ''}
            {formatDateTime(comment.created_at)}
          </span>
          <div className="flex items-center gap-2">
            {stateLabel && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                {stateLabel}
              </span>
            )}
            {onAction && (unanswered ? (
              <>
                <button
                  type="button"
                  className="hover:text-foreground"
                  disabled={actionPending}
                  onClick={() => onAction('resolve')}
                >
                  resolve
                </button>
                <button
                  type="button"
                  className="hover:text-foreground"
                  disabled={actionPending}
                  onClick={snooze}
                >
                  snooze
                </button>
              </>
            ) : (
              <button
                type="button"
                className="hover:text-foreground"
                disabled={actionPending}
                onClick={() => onAction('reopen')}
              >
                reopen
              </button>
            ))}
            <button type="button" className="hover:text-foreground" onClick={onReply}>
              {replyingTo === comment.id ? 'replying…' : 'reply'}
            </button>
            <button
              type="button"
              aria-label="Delete comment"
              className="hover:text-destructive"
              onClick={() => onDelete(comment.id)}
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
            </button>
          </div>
        </div>
        <p className="whitespace-pre-wrap text-sm">{comment.body}</p>
      </div>
      {replies.length > 0 && (
        <div className="ml-4 space-y-2 border-l pl-3">
          {replies.map(reply => (
            <div key={reply.id} className="rounded-md border bg-muted/20 px-2 py-1.5">
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>
                  {authorName ? `${authorName(reply)} · ` : ''}
                  {formatDateTime(reply.created_at)}
                </span>
                <button
                  type="button"
                  aria-label="Delete comment"
                  className="hover:text-destructive"
                  onClick={() => onDelete(reply.id)}
                >
                  <Trash2 className="h-3 w-3" aria-hidden="true" />
                </button>
              </div>
              <p className="whitespace-pre-wrap text-sm">{reply.body}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
