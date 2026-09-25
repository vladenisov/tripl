import { useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import type { EventMutationResponse, EventType, MetaFieldDefinition, Variable } from '@/types'
import { eventCommentsApi } from '@/api/eventComments'
import { eventsApi } from '@/api/events'
import { eventTypesApi } from '@/api/eventTypes'
import { metaFieldsApi } from '@/api/metaFields'
import { variablesApi } from '@/api/variables'
import { useActiveBranchId } from '@/hooks/useBranch'
import { displayUser, useUsersById } from '@/hooks/useUsersById'
import { CommentThread } from '@/components/comment-thread'
import { EntityBranchBanner } from '@/components/EntityBranchBanner'
import { ErrorState } from '@/components/error-state'
import { PageContainer } from '@/components/primitives/page-container'
import { eventCommentsKey, eventKey, eventTypesKey, metaFieldsKey, variablesKey } from '@/lib/queryKeys'
import { getErrorMessage } from '@/lib/utils'
import { DraftDiscussionNote } from './DraftDiscussionNote'
import { EventForm } from './EventFormView'

const EMPTY_EVENT_TYPES: EventType[] = []
const EMPTY_META_FIELDS: MetaFieldDefinition[] = []
const EMPTY_VARIABLES: Variable[] = []

/**
 * Page-based route wrapper: loads the data EventForm needs (event types, meta
 * fields, variables, and — when editing — the event itself) and renders the
 * form full-page. Reached via `/p/:slug/events/:tab/new` and
 * `/p/:slug/events/:tab/:eventId/edit`. Replaces the old inline Sheet.
 */
export default function EventEditPage() {
  const { slug, tab, eventId } = useParams<{ slug: string; tab?: string; eventId?: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const branchId = useActiveBranchId()
  const usersById = useUsersById()
  const isNew = !eventId

  // Reviewing a branch and fixing three of its events used to cost three round
  // trips through Settings > Branches, because closing the editor always landed
  // on the events list. Go back to wherever the editor was opened from instead
  // — react-router gives the initial history entry the key 'default', so this
  // only steps back when there is somewhere in-app to step back to, and the
  // list stays the answer for a cold-opened URL.
  const goBack = () => {
    if (location.key !== 'default') {
      navigate(-1)
      return
    }
    const base = !tab || tab === 'all' ? `/p/${slug}/events` : `/p/${slug}/events/${tab}`
    // With the query string: the list's filters and the `?branch=` EventsPage
    // carries here on purpose, which a cold-opened link otherwise lost (EVT-38).
    navigate(`${base}${location.search}`)
  }

  // A question raised while the event is being authored. It cannot be a comment
  // yet — a comment hangs off an event — so it is held here and posted the
  // moment one exists (tripl-htfn.1).
  const [draftNote, setDraftNote] = useState('')
  // What a previous attempt could not post, handed across the navigation below
  // so the words are not lost with the request that failed.
  const handoff = location.state as { commentDraft?: string; commentError?: string } | null

  const postDraftNote = async (created: EventMutationResponse): Promise<boolean> => {
    const body = draftNote.trim()
    if (!body) return true
    try {
      await eventCommentsApi.create(slug!, created.id, body, null)
      setDraftNote('')
      return true
    } catch (error) {
      // The event EXISTS. Leaving its author on a create form for it is the
      // worse failure — pressing Create again makes a second one — so land them
      // on the event, carrying what they wrote into its own composer. `replace`
      // keeps Back meaning what it meant before the save.
      navigate(`/p/${slug}/events/${tab ?? 'all'}/${created.id}/edit${location.search}`, {
        replace: true,
        state: {
          commentDraft: body,
          commentError: `The event was created, but the note was not posted: ${getErrorMessage(error)}`,
        },
      })
      return false
    }
  }

  const eventTypesQuery = useQuery({
    queryKey: eventTypesKey(slug, branchId),
    queryFn: () => eventTypesApi.list(slug!, branchId),
    enabled: !!slug,
  })
  const metaFieldsQuery = useQuery({
    queryKey: metaFieldsKey(slug, branchId),
    queryFn: () => metaFieldsApi.list(slug!, branchId),
    enabled: !!slug,
  })
  const variablesQuery = useQuery({
    queryKey: variablesKey(slug, branchId),
    queryFn: () => variablesApi.list(slug!, branchId),
    enabled: !!slug,
  })
  const eventQuery = useQuery({
    queryKey: eventKey(slug, branchId, eventId),
    queryFn: () => eventsApi.get(slug!, eventId!, branchId),
    enabled: !!slug && !!eventId,
  })

  const loadError =
    eventTypesQuery.error ?? metaFieldsQuery.error ?? variablesQuery.error ?? eventQuery.error

  if (loadError) {
    return (
      <PageContainer width="narrow">
        <ErrorState
          title="Failed to load event editor"
          error={loadError}
          onRetry={() => {
            void Promise.all([
              eventTypesQuery.refetch(),
              metaFieldsQuery.refetch(),
              variablesQuery.refetch(),
              ...(eventId ? [eventQuery.refetch()] : []),
            ])
          }}
        />
      </PageContainer>
    )
  }

  const isLoading =
    eventTypesQuery.isLoading
    || metaFieldsQuery.isLoading
    || variablesQuery.isLoading
    || (!isNew && eventQuery.isLoading)

  if (isLoading || !slug) {
    return (
      <div className="flex min-h-[240px] items-center justify-center text-body-sm" style={{ color: 'var(--fg-subtle)' }}>
        Loading…
      </div>
    )
  }

  const eventTypesData = eventTypesQuery.data ?? EMPTY_EVENT_TYPES
  // On a scoped event-type tab, pre-select that type when creating a new event.
  const defaultEventTypeId = isNew && tab && tab !== 'all'
    ? eventTypesData.find(et => et.name === tab)?.id
    : undefined

  return (
    <div className="h-full overflow-y-auto">
      {eventId ? (
        // The form is where a branch edit is actually made, and it was the one
        // authoring surface that never said which plan it was writing to. The
        // read is lenient and the write is strict, so a mismatch rendered a
        // perfectly normal form and failed as a bare 404 at Save.
        // The form's narrow column, from the shell's own left edge (DS-3).
        <div className="mb-4 max-w-[880px]">
          <EntityBranchBanner
            slug={slug}
            rowBranchId={eventQuery.data?.branch_id}
            path={`/p/${slug}/events/${tab ?? 'all'}/${eventId}/edit`}
            // Not this page's id on main: it is the branch row's, which main
            // would render again under a mismatch warning (EVT-42). The main
            // twin's page when the server names one, else the list on main.
            mainPath={
              eventQuery.data?.main_event_id
                ? `/p/${slug}/events/${tab ?? 'all'}/${eventQuery.data.main_event_id}/edit`
                : !tab || tab === 'all'
                  ? `/p/${slug}/events`
                  : `/p/${slug}/events/${tab}`
            }
          />
        </div>
      ) : null}
      <EventForm
        slug={slug}
        eventTypes={eventTypesData}
        metaFields={metaFieldsQuery.data ?? EMPTY_META_FIELDS}
        projectVariables={variablesQuery.data ?? EMPTY_VARIABLES}
        event={eventQuery.data ?? null}
        defaultEventTypeId={defaultEventTypeId}
        onClose={goBack}
        onCreated={postDraftNote}
        hasOtherUnsavedInput={draftNote.trim() !== ''}
        beforeActions={
          eventId ? undefined : (
            <div className="mb-[18px]">
              <DraftDiscussionNote value={draftNote} onChange={setDraftNote} />
            </div>
          )
        }
      />
      {/* The one home for the discussion, and outside the form on purpose: it
          is not plan content. Every other box on this page ships to whoever
          implements the event — Description is an indexed search column and a
          line in the pasted spec — so "should this fire on cancel too?" typed
          there reads as part of the specification. Edit only: there is no
          event to hang a thread on until one exists. */}
      {eventId && (
        // Below the sticky save bar with a clear break, so the page end is not
        // mistaken for more of the form (AU-6).
        <div className="mt-10 max-w-[880px] pb-10">
          {handoff?.commentError && (
            <p role="alert" className="mb-2 text-body-sm text-destructive">
              {handoff.commentError}
            </p>
          )}
          <CommentThread
            initialBody={handoff?.commentDraft}
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
            composerId="event-discussion-body"
            className="flex flex-col rounded-md border bg-card p-3"
          />
        </div>
      )}
    </div>
  )
}
