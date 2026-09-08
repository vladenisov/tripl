import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommentThread, type ThreadComment } from './comment-thread'

function comment(overrides: Partial<ThreadComment> & { id: string }): ThreadComment {
  return {
    parent_id: null,
    body: 'a comment',
    created_at: '2026-09-08T10:00:00Z',
    ...overrides,
  }
}

let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children)
}

function renderThread(
  rows: ThreadComment[],
  handlers: Partial<{
    create: (body: string, parentId: string | null) => Promise<unknown>
    remove: (commentId: string) => Promise<unknown>
    authorName: (comment: ThreadComment) => string
    onCreated: () => void
  }> = {},
) {
  const create = handlers.create ?? vi.fn().mockResolvedValue({})
  const remove = handlers.remove ?? vi.fn().mockResolvedValue(undefined)
  const view = render(
    createElement(CommentThread, {
      queryKey: ['thread', 'demo'],
      list: () => Promise.resolve(rows),
      create,
      remove,
      authorName: handlers.authorName,
      onCreated: handlers.onCreated,
    }),
    { wrapper },
  )
  return { ...view, create, remove }
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(() => {
  queryClient.clear()
  vi.clearAllMocks()
})

describe('CommentThread', () => {
  it('says the thread is empty rather than showing nothing', async () => {
    renderThread([])
    expect(await screen.findByText('No comments yet. Start the thread.')).toBeInTheDocument()
    expect(screen.getByText('(0)')).toBeInTheDocument()
  })

  it('nests replies under the comment they answer', async () => {
    renderThread([
      comment({ id: 'c1', body: 'should this fire on cancel?' }),
      comment({ id: 'c2', parent_id: 'c1', body: 'no, cancel has its own event' }),
    ])
    const top = await screen.findByText('should this fire on cancel?')
    expect(screen.getByText('(2)')).toBeInTheDocument()
    // The reply renders inside the top-level comment's block, not beside it.
    const block = top.closest('.space-y-2')
    expect(block?.textContent).toContain('no, cancel has its own event')
  })

  it('posts a reply against the comment being answered', async () => {
    const { create } = renderThread([comment({ id: 'c1' })])
    fireEvent.click(await screen.findByRole('button', { name: 'reply' }))

    fireEvent.change(screen.getByLabelText('Write a comment'), {
      target: { value: 'answering' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))

    await waitFor(() => expect(create).toHaveBeenCalledWith('answering', 'c1'))
  })

  it('composes in a div, so a thread can live inside another form', async () => {
    // A nested <form> is invalid HTML: the browser drops the inner one, and the
    // composer's submit would save the surrounding event instead of posting.
    const { container, create } = renderThread([])
    await screen.findByText('No comments yet. Start the thread.')
    expect(container.querySelector('form')).toBeNull()

    const box = screen.getByLabelText('Write a comment')
    fireEvent.change(box, { target: { value: 'raised for discussion' } })
    // The shortcut every chat box uses; plain Enter belongs to the text.
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(create).not.toHaveBeenCalled()

    fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(create).toHaveBeenCalledWith('raised for discussion', null))
  })

  it('will not post an empty comment', async () => {
    const { create } = renderThread([])
    await screen.findByText('No comments yet. Start the thread.')
    fireEvent.change(screen.getByLabelText('Write a comment'), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: 'Comment' })).toBeDisabled()
    expect(create).not.toHaveBeenCalled()
  })

  it('deletes the comment whose control was used', async () => {
    const { remove } = renderThread([
      comment({ id: 'c1', body: 'first' }),
      comment({ id: 'c2', body: 'second' }),
    ])
    await screen.findByText('second')
    const controls = screen.getAllByRole('button', { name: 'Delete comment' })
    fireEvent.click(controls[1])
    await waitFor(() => expect(remove).toHaveBeenCalledWith('c2'))
  })
})

describe('CommentThread authors (tripl-h2sx.27)', () => {
  it('names the author on a comment and on its reply', async () => {
    renderThread(
      [
        comment({ id: 'c-1', body: 'Is this still shipping?', user_id: 'u-1' }),
        comment({ id: 'c-2', parent_id: 'c-1', body: 'Yes, in March.', user_id: 'u-2' }),
      ],
      { authorName: c => (c.user_id === 'u-1' ? 'Ada' : 'Grace') },
    )

    expect(await screen.findByText(/Ada ·/)).toBeInTheDocument()
    expect(screen.getByText(/Grace ·/)).toBeInTheDocument()
  })

  it('stays anonymous when no resolver is given', async () => {
    renderThread([comment({ id: 'c-1', body: 'hi', user_id: 'u-1' })])

    expect(await screen.findByText('hi')).toBeInTheDocument()
    expect(screen.queryByText(/ · /)).not.toBeInTheDocument()
  })

  it('fires onCreated after a post — the demo scenario hangs off it', async () => {
    const onCreated = vi.fn()
    renderThread([], { onCreated })

    fireEvent.change(await screen.findByLabelText('Write a comment'), {
      target: { value: 'first' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }))

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1))
  })
})
