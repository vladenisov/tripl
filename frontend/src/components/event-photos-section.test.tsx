import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventPhoto } from '@/types'
import { eventPhotosApi } from '@/api/eventPhotos'
import EventPhotosSection from './event-photos-section'

vi.mock('@/api/eventPhotos', () => ({
  eventPhotosApi: {
    list: vi.fn(),
    upload: vi.fn(),
    delete: vi.fn(),
    attachFigma: vi.fn(),
    listComments: vi.fn(),
    createComment: vi.fn(),
    deleteComment: vi.fn(),
  },
}))
vi.mock('@/api/users', () => ({
  usersApi: { list: vi.fn().mockResolvedValue([]) },
}))

const PHOTO = {
  id: 'ph-1',
  kind: 'image',
  url: '/files/ph-1.png',
  original_filename: '',
  size_bytes: 2048,
  storage_backend: 'local',
  external_url: null,
} as unknown as EventPhoto

let queryClient: QueryClient

function renderSection() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  return render(<EventPhotosSection slug="demo" eventId="ev-1" />, { wrapper })
}

function image(name: string, size = 1024, type = 'image/png'): File {
  const file = new File(['x'], name, { type })
  Object.defineProperty(file, 'size', { value: size })
  return file
}

function drop(files: File[]) {
  fireEvent.drop(screen.getByRole('region', { name: 'Photo upload area' }), {
    dataTransfer: { files },
  })
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.mocked(eventPhotosApi.list).mockResolvedValue([])
  vi.mocked(eventPhotosApi.listComments).mockResolvedValue([])
  vi.mocked(eventPhotosApi.upload).mockReset()
})

describe('EventPhotosSection uploads (EVT-28)', () => {
  it('uploads every file, and shows what landed even when one fails', async () => {
    vi.mocked(eventPhotosApi.upload).mockImplementation(async (_slug, _event, file) => {
      if (file.name === 'b.png') throw new Error('413 Request Entity Too Large')
      return { ...PHOTO, id: file.name } as EventPhoto
    })
    renderSection()
    await screen.findByText(/Drop images here/)
    const listCalls = vi.mocked(eventPhotosApi.list).mock.calls.length

    drop([image('a.png'), image('b.png'), image('c.png')])

    await waitFor(() => expect(eventPhotosApi.upload).toHaveBeenCalledTimes(3))
    // The failure is named, per file…
    const uploads = await screen.findByRole('list', { name: 'Uploads' })
    expect(await within(uploads).findByText('b.png')).toBeInTheDocument()
    expect(within(uploads).getByRole('alert')).toHaveTextContent('413 Request Entity Too Large')
    // …and the list is refreshed, so a.png and c.png show without a reload.
    await waitFor(() =>
      expect(vi.mocked(eventPhotosApi.list).mock.calls.length).toBeGreaterThan(listCalls),
    )
    expect(within(uploads).queryByText('a.png')).toBeNull()
  })

  it('reports the files it will not upload instead of dropping them silently', async () => {
    vi.mocked(eventPhotosApi.upload).mockResolvedValue(PHOTO)
    renderSection()
    await screen.findByText(/Drop images here/)

    drop([image('ok.png'), image('notes.pdf', 1024, 'application/pdf')])

    const notice = await screen.findByRole('status')
    expect(notice).toHaveTextContent('notes.pdf (not an image)')
    await waitFor(() => expect(eventPhotosApi.upload).toHaveBeenCalledTimes(1))
    expect(vi.mocked(eventPhotosApi.upload).mock.calls[0]?.[2]).toHaveProperty('name', 'ok.png')
  })

  it('leaves size and image type to the server, whose limits are owner settings', async () => {
    vi.mocked(eventPhotosApi.upload).mockResolvedValue(PHOTO)
    renderSection()
    await screen.findByText(/Drop images here/)

    // An instance may allow AVIF or a 25 MB limit; the browser cannot know,
    // so neither file is refused here — the large one only carries a warning.
    drop([image('photo.avif', 1024, 'image/avif'), image('huge.png', 15 * 1024 * 1024)])

    await waitFor(() => expect(eventPhotosApi.upload).toHaveBeenCalledTimes(2))
    const names = vi.mocked(eventPhotosApi.upload).mock.calls.map(call => call[2].name)
    expect(names).toEqual(['photo.avif', 'huge.png'])
    expect(screen.getByRole('status')).toHaveTextContent(
      'Larger than the default 10 MB limit: huge.png.',
    )
    expect(screen.queryByText(/Not uploaded/)).toBeNull()
  })

  it('shows progress while a file uploads', async () => {
    let report: ((fraction: number) => void) | undefined
    vi.mocked(eventPhotosApi.upload).mockImplementation(
      (_slug, _event, _file, onProgress) =>
        new Promise<EventPhoto>(() => {
          report = onProgress
        }),
    )
    renderSection()
    await screen.findByText(/Drop images here/)
    drop([image('slow.png')])

    const bar = await screen.findByRole('progressbar', { name: 'Uploading slow.png' })
    expect(bar).toHaveAttribute('value', '0')
    report?.(0.4)
    await waitFor(() => expect(bar).toHaveAttribute('value', '40'))
    expect(screen.getByText('40%')).toBeInTheDocument()
  })
})

describe('EventPhotosSection viewer (EVT-51)', () => {
  it('names a tile whose image has no filename, and the viewer has one close button', async () => {
    vi.mocked(eventPhotosApi.list).mockResolvedValue([PHOTO])
    renderSection()

    const tile = await screen.findByRole('button', { name: 'Open photo' })
    fireEvent.click(tile)

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getAllByRole('button', { name: 'Close' })).toHaveLength(1)
    // Every button in the viewer has a name.
    for (const button of within(dialog).getAllByRole('button')) {
      expect(button).toHaveAccessibleName()
    }
  })
})
