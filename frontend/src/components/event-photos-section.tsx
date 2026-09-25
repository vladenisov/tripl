import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { eventPhotosApi } from '@/api/eventPhotos'
import type { EventPhoto } from '@/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { CommentThread } from '@/components/comment-thread'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Frame, ImagePlus, Loader2, Trash2, Upload } from 'lucide-react'
import { useConfirm } from '@/hooks/useConfirm'
import { displayUser, useUsersById } from '@/hooks/useUsersById'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { useCanWriteProject } from '@/lib/permissions'
import { eventPhotoCommentsKey, eventPhotosKey } from '@/lib/queryKeys'

interface Props {
  slug: string
  eventId: string
}

/**
 * Which types and sizes the server stores are owner settings
 * (`photo_allowed_mime`, `photo_max_size_mb`) the client cannot read, so the
 * browser only filters out what is not an image at all and lets the server's
 * 413/415 speak for the rest. A fixed list and a hard 10 MB gate here refused
 * files an instance had been configured to take.
 */
const ACCEPT = 'image/*'

/**
 * The server's DEFAULT `photo_max_size_mb`. A larger file still uploads — the
 * instance may have raised the limit — but the author is told up front why it
 * may come back refused, instead of meeting a bare 413 after a long upload
 * (EVT-28).
 */
const PHOTO_DEFAULT_MAX_SIZE_MB = 10
const PHOTO_DEFAULT_MAX_BYTES = PHOTO_DEFAULT_MAX_SIZE_MB * 1024 * 1024

/** One file of an upload, as the list under the drop zone shows it. */
interface UploadItem {
  key: string
  name: string
  /** 0..1 */
  progress: number
  status: 'uploading' | 'failed'
  error?: string
}

/** Why a dropped or picked file is not uploaded at all, or null to upload it. */
function photoRejection(file: Pick<File, 'type'>): string | null {
  return file.type.startsWith('image/') ? null : 'not an image'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function figmaEmbedUrl(externalUrl: string): string {
  // Figma's embed endpoint accepts the canonical file/proto URL as the `url`
  // query param. Keep the original URL alone so we still have a "Open in
  // Figma" link to show the user.
  return `https://www.figma.com/embed?embed_host=tripl&url=${encodeURIComponent(externalUrl)}`
}

export default function EventPhotosSection({ slug, eventId }: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const queryClient = useQueryClient()
  // Upload, attach and delete are editor actions; a viewer browses the specs.
  const canWrite = useCanWriteProject()
  const [error, setError] = useState<string | null>(null)
  const [opened, setOpened] = useState<EventPhoto | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [figmaUrl, setFigmaUrl] = useState('')
  const [figmaTitle, setFigmaTitle] = useState('')
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const [skipped, setSkipped] = useState<string[]>([])
  const [oversized, setOversized] = useState<string[]>([])
  const uploadSeq = useRef(0)
  const { confirm, dialog } = useConfirm()

  const photosKey = eventPhotosKey(slug, eventId)
  const photosQuery = useQuery({
    queryKey: photosKey,
    queryFn: () => eventPhotosApi.list(slug, eventId),
    enabled: !!slug && !!eventId,
  })

  // Files upload side by side, each with its own progress and outcome. They
  // used to go one after another inside one mutation: no progress, and when the
  // third of five failed the first two were stored but stayed off screen until
  // a reload, because only a fully successful run refreshed the list (EVT-28).
  const patchUpload = (key: string, patch: Partial<UploadItem>) =>
    setUploads(items => items.map(item => (item.key === key ? { ...item, ...patch } : item)))

  const uploadOne = async (file: File, key: string) => {
    try {
      await eventPhotosApi.upload(slug, eventId, file, progress => patchUpload(key, { progress }))
      setUploads(items => items.filter(item => item.key !== key))
    } catch (err) {
      patchUpload(key, {
        status: 'failed',
        error: err instanceof Error ? err.message : 'Upload failed',
      })
    } finally {
      // Settled either way: whatever did land is shown now.
      void queryClient.invalidateQueries({ queryKey: photosKey })
    }
  }

  const uploading = uploads.some(item => item.status === 'uploading')

  const figmaMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: () => eventPhotosApi.attachFigma(slug, eventId, figmaUrl.trim(), figmaTitle.trim()),
    onSuccess: () => {
      setError(null)
      setFigmaUrl('')
      setFigmaTitle('')
      void queryClient.invalidateQueries({ queryKey: photosKey })
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Figma attach failed')
    },
  })

  const deleteMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: (photoId: string) => eventPhotosApi.delete(slug, eventId, photoId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: photosKey })
      setOpened(null)
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Delete failed')
    },
  })

  const handleDelete = async (photo: EventPhoto) => {
    const isFigma = photo.kind === 'figma'
    const ok = await confirm({
      title: isFigma ? 'Detach Figma spec' : 'Delete photo',
      message: isFigma
        ? 'Detach this Figma spec from the event? The file in Figma is not affected.'
        : `Delete ${photo.original_filename || 'this photo'}? This cannot be undone.`,
      confirmLabel: isFigma ? 'Detach' : 'Delete',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate(photo.id)
  }

  const handleFiles = (files: FileList | File[] | null) => {
    if (!files) return
    const accepted: File[] = []
    const refused: string[] = []
    for (const file of Array.from(files)) {
      const reason = photoRejection(file)
      if (reason) refused.push(`${file.name} (${reason})`)
      else accepted.push(file)
    }
    // A mixed drop used to discard what it could not take without a word.
    setSkipped(refused)
    setOversized(accepted.filter(file => file.size > PHOTO_DEFAULT_MAX_BYTES).map(file => file.name))
    setError(null)
    // A new batch replaces the failures of the last one.
    const batch = accepted.map(file => {
      uploadSeq.current += 1
      return { file, key: `upload-${uploadSeq.current}` }
    })
    setUploads(items => [
      ...items.filter(item => item.status === 'uploading'),
      ...batch.map(({ file, key }) => ({ key, name: file.name, progress: 0, status: 'uploading' as const })),
    ])
    for (const { file, key } of batch) void uploadOne(file, key)
  }

  const photos = photosQuery.data ?? []

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ImagePlus className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Photos &amp; specs</h2>
            <span className="text-xs text-muted-foreground">({photos.length})</span>
          </div>
          {canWrite && (
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept={ACCEPT}
                multiple
                className="hidden"
                onChange={event => {
                  handleFiles(event.target.files)
                  event.target.value = ''
                }}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
              >
                {uploading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                Upload image
              </Button>
            </div>
          )}
        </div>

        {canWrite && (
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border bg-muted/30 px-3 py-2">
            <Frame className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
            <label htmlFor="figma-url" className="sr-only">Figma URL</label>
            <Input
              id="figma-url"
              placeholder="https://www.figma.com/file/…"
              value={figmaUrl}
              onChange={event => setFigmaUrl(event.target.value)}
              className="h-8 max-w-md"
            />
            <label htmlFor="figma-title" className="sr-only">Title (optional)</label>
            <Input
              id="figma-title"
              placeholder="Title (optional)"
              value={figmaTitle}
              onChange={event => setFigmaTitle(event.target.value)}
              className="h-8 max-w-xs"
            />
            <Button
              size="sm"
              variant="secondary"
              disabled={!figmaUrl.trim() || figmaMut.isPending}
              onClick={() => figmaMut.mutate()}
            >
              {figmaMut.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Attach spec
            </Button>
          </div>
        )}

        <div
          role="region"
          aria-label="Photo upload area"
          onDragOver={event => {
            if (!canWrite) return
            event.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={event => {
            if (!canWrite) return
            event.preventDefault()
            setDragOver(false)
            handleFiles(event.dataTransfer.files)
          }}
          className={`rounded-md border-2 border-dashed p-4 transition-colors ${
            dragOver ? 'border-primary bg-primary/5' : 'border-muted-foreground/20'
          }`}
        >
          {photosQuery.isLoading ? (
            <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
              Loading photos…
            </div>
          ) : photos.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-1 py-6 text-center text-sm text-muted-foreground">
              <ImagePlus className="h-6 w-6 text-muted-foreground/70" />
              {canWrite ? (
                <>
                  <div>Drop images here, click <span className="font-medium">Upload</span>, or attach a Figma URL above</div>
                  <div className="text-xs">JPEG, PNG, GIF, or WebP</div>
                </>
              ) : (
                <div>No photos or specs attached yet.</div>
              )}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {photos.map(photo => (
                <PhotoTile
                  key={photo.id}
                  photo={photo}
                  onOpen={() => setOpened(photo)}
                  onDelete={canWrite ? () => {
                    void handleDelete(photo)
                  } : undefined}
                  deleting={deleteMut.isPending && deleteMut.variables === photo.id}
                />
              ))}
            </div>
          )}
        </div>

        {uploads.length > 0 && (
          <ul className="mt-3 space-y-1.5" aria-label="Uploads">
            {uploads.map(item => (
              <li key={item.key} className="text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate" title={item.name}>{item.name}</span>
                  <span className={item.status === 'failed' ? 'shrink-0 text-destructive' : 'shrink-0 text-muted-foreground'}>
                    {item.status === 'failed' ? 'Failed' : `${Math.round(item.progress * 100)}%`}
                  </span>
                </div>
                {item.status === 'uploading' ? (
                  <progress
                    className="h-1 w-full"
                    value={Math.round(item.progress * 100)}
                    max={100}
                    aria-label={`Uploading ${item.name}`}
                  />
                ) : (
                  <p role="alert" className="text-destructive">{item.error}</p>
                )}
              </li>
            ))}
          </ul>
        )}

        {skipped.length > 0 && (
          <div role="status" className="mt-3 rounded-md border px-3 py-2 text-xs text-muted-foreground">
            Not uploaded: {skipped.join(', ')}.
          </div>
        )}

        {oversized.length > 0 && (
          <div role="status" className="mt-3 rounded-md border px-3 py-2 text-xs text-muted-foreground">
            Larger than the default {PHOTO_DEFAULT_MAX_SIZE_MB} MB limit: {oversized.join(', ')}. Uploading
            anyway; the server refuses {oversized.length === 1 ? 'it' : 'them'} if this instance keeps
            that limit.
          </div>
        )}

        {error && (
          <div role="alert" className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
      </CardContent>

      {dialog}

      <Dialog open={opened !== null} onOpenChange={open => !open && setOpened(null)}>
        {/* No description: the image and its thread are the content. Saying so
            outright keeps Radix from warning about a missing one. */}
        <DialogContent className="max-w-5xl bg-background p-2" aria-describedby={undefined}>
          <DialogTitle className="sr-only">
            {opened?.original_filename || 'Photo viewer'}
          </DialogTitle>
          {opened && (
            <PhotoViewer photo={opened} slug={slug} eventId={eventId} />
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}

function PhotoTile({
  photo,
  onOpen,
  onDelete,
  deleting,
}: {
  photo: EventPhoto
  onOpen: () => void
  /** Omitted for a viewer, who gets the tile without its delete button. */
  onDelete?: () => void
  deleting: boolean
}) {
  const isFigma = photo.kind === 'figma'

  return (
    <div className="group relative overflow-hidden rounded-md border bg-muted">
      {/* Named outright: an image with no filename renders alt="" and left
          the tile's only button with no name at all (EVT-51). */}
      <button
        type="button"
        onClick={onOpen}
        className="block w-full"
        aria-label={`Open ${photo.original_filename || (isFigma ? 'Figma frame' : 'photo')}`}
      >
        {isFigma ? (
          <div className="flex aspect-square w-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-purple-500/10 via-orange-500/10 to-pink-500/10 p-3 text-center">
            <Frame className="h-8 w-8 text-foreground/70" />
            <span className="line-clamp-2 text-xs font-medium text-foreground/80">
              {photo.original_filename || 'Figma frame'}
            </span>
          </div>
        ) : (
          <img
            src={photo.url}
            alt=""
            className="aspect-square w-full object-cover"
            loading="lazy"
          />
        )}
      </button>
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100">
        <span className="truncate text-xs text-white" title={photo.original_filename}>
          {photo.original_filename || (isFigma ? 'Figma frame' : 'photo')}
        </span>
        {onDelete && (
          <Button
            size="icon"
            variant="destructive"
            aria-label="Delete photo"
            className="h-7 w-7 shrink-0"
            disabled={deleting}
            onClick={event => {
              event.stopPropagation()
              onDelete()
            }}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        )}
      </div>
      <div className="absolute right-1 top-1 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white">
        {isFigma ? 'Figma' : formatSize(photo.size_bytes)}
      </div>
    </div>
  )
}

function PhotoViewer({
  photo,
  slug,
  eventId,
}: {
  photo: EventPhoto
  slug: string
  eventId: string
}) {
  const isFigma = photo.kind === 'figma'
  const usersById = useUsersById()

  return (
    <div className="grid gap-2 md:grid-cols-[1fr_320px]">
      <div className="relative">
        {isFigma && photo.external_url ? (
          <iframe
            title={photo.original_filename || 'Figma embed'}
            src={figmaEmbedUrl(photo.external_url)}
            className="h-[70vh] w-full rounded-md border bg-muted"
            allowFullScreen
          />
        ) : (
          <img
            src={photo.url}
            alt={photo.original_filename || 'Photo'}
            className="max-h-[75vh] w-full object-contain"
          />
        )}
        {/* No close button of its own: DialogContent already renders a labelled
            one, and a second, unlabelled X beside it read as "button" (EVT-51). */}
        <div className="flex items-center justify-between gap-2 px-2 pt-2 text-xs text-muted-foreground">
          <span className="truncate">
            {photo.original_filename}
            {!isFigma && ` · ${formatSize(photo.size_bytes)}`}
            {photo.storage_backend ? ` · ${photo.storage_backend}` : ''}
          </span>
          {isFigma && photo.external_url && (
            <a
              href={photo.external_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:underline"
            >
              Open in Figma →
            </a>
          )}
        </div>
      </div>
      <CommentThread
        queryKey={eventPhotoCommentsKey(slug, eventId, photo.id)}
        list={() => eventPhotosApi.listComments(slug, eventId, photo.id)}
        create={(body, parentId) =>
          eventPhotosApi.createComment(slug, eventId, photo.id, body, parentId)
        }
        remove={commentId => eventPhotosApi.deleteComment(slug, eventId, photo.id, commentId)}
        authorName={comment => displayUser(usersById, comment.user_id)}
      />
    </div>
  )
}
