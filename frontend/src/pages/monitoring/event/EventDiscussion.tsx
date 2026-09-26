import { eventCommentsApi } from '@/api/eventComments'
import { CommentThread } from '@/components/comment-thread'
import { displayUser, useUsersById } from '@/hooks/useUsersById'
import { eventCommentsKey } from '@/lib/queryKeys'

/**
 * The event's discussion on its detail page. Viewers are sent here from the
 * edit URL (EV-34), and the editor was the only place the thread was drawn, so
 * a viewer lost the one way to read it. Same thread and cache key as the edit
 * page; CommentThread hides the composer from anyone who cannot write.
 */
export function EventDiscussion({ slug, eventId }: { slug: string; eventId: string }) {
  const usersById = useUsersById()
  return (
    <CommentThread
      queryKey={eventCommentsKey(slug, eventId)}
      list={() => eventCommentsApi.list(slug, eventId)}
      create={(body, parentId) => eventCommentsApi.create(slug, eventId, body, parentId)}
      remove={commentId => eventCommentsApi.remove(slug, eventId, commentId)}
      onAction={(commentId, action, snoozedUntil) =>
        eventCommentsApi.action(slug, eventId, commentId, action, snoozedUntil)
      }
      authorName={comment => displayUser(usersById, comment.user_id)}
      heading="Discussion"
      emptyText="Nothing raised yet. Questions and notes here stay out of the spec."
      composerId="event-detail-discussion-body"
      className="flex flex-col rounded-card border bg-(--surface) p-4"
    />
  )
}
