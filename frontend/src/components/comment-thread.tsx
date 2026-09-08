import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Loader2, MessageCircle, Trash2 } from 'lucide-react'
import { formatDateTime } from '@/lib/datetime'

/**
 * The shape the thread renders. Both anchors — a photo and an event — keep
 * their comments in the same table, so this is the same row either way.
 */
export interface ThreadComment {
  id: string
  parent_id: string | null
  body: string
  created_at: string
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
}

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
    },
  })

  const deleteMut = useMutation({
    mutationFn: (commentId: string) => remove(commentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: [...queryKey] })
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
}: {
  comment: ThreadComment
  replies: ThreadComment[]
  onReply: () => void
  onDelete: (id: string) => void
  replyingTo: string | null
}) {
  return (
    <div className="space-y-2">
      <div className="rounded-md border bg-muted/30 px-2 py-1.5">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{formatDateTime(comment.created_at)}</span>
          <div className="flex items-center gap-2">
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
                <span>{formatDateTime(reply.created_at)}</span>
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
