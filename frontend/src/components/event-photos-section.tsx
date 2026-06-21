import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { eventPhotosApi } from '@/api/eventPhotos'
import type { EventPhoto, EventPhotoComment } from '@/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Frame, ImagePlus, Loader2, MessageCircle, Trash2, Upload, X } from 'lucide-react'

interface Props {
  slug: string
  eventId: string
}

const ACCEPT = 'image/jpeg,image/png,image/gif,image/webp'

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
  const [error, setError] = useState<string | null>(null)
  const [opened, setOpened] = useState<EventPhoto | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [figmaUrl, setFigmaUrl] = useState('')
  const [figmaTitle, setFigmaTitle] = useState('')

  const photosKey = ['eventPhotos', slug, eventId]
  const photosQuery = useQuery({
    queryKey: photosKey,
    queryFn: () => eventPhotosApi.list(slug, eventId),
    enabled: !!slug && !!eventId,
  })

  const uploadMut = useMutation({
    mutationFn: async (files: File[]) => {
      const uploaded: EventPhoto[] = []
      for (const file of files) {
        uploaded.push(await eventPhotosApi.upload(slug, eventId, file))
      }
      return uploaded
    },
    onSuccess: () => {
      setError(null)
      void queryClient.invalidateQueries({ queryKey: photosKey })
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Upload failed')
    },
  })

  const figmaMut = useMutation({
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
    mutationFn: (photoId: string) => eventPhotosApi.delete(slug, eventId, photoId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: photosKey })
      setOpened(null)
    },
    onError: (err: unknown) => {
      setError(err instanceof Error ? err.message : 'Delete failed')
    },
  })

  const handleFiles = (files: FileList | File[] | null) => {
    if (!files) return
    const list = Array.from(files).filter(file => file.type.startsWith('image/'))
    if (list.length === 0) {
      setError('Only image files are supported')
      return
    }
    uploadMut.mutate(list)
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
              disabled={uploadMut.isPending}
            >
              {uploadMut.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-2 h-4 w-4" />
              )}
              Upload image
            </Button>
          </div>
        </div>

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

        <div
          role="region"
          aria-label="Photo upload area"
          onDragOver={event => {
            event.preventDefault()
            setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={event => {
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
              <div>Drop images here, click <span className="font-medium">Upload</span>, or attach a Figma URL above</div>
              <div className="text-xs">JPEG, PNG, GIF, or WebP</div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {photos.map(photo => (
                <PhotoTile
                  key={photo.id}
                  photo={photo}
                  onOpen={() => setOpened(photo)}
                  onDelete={() => {
                    if (window.confirm(photo.kind === 'figma' ? 'Detach this Figma spec?' : 'Delete this photo?')) {
                      deleteMut.mutate(photo.id)
                    }
                  }}
                  deleting={deleteMut.isPending}
                />
              ))}
            </div>
          )}
        </div>

        {error && (
          <div role="alert" className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
      </CardContent>

      <Dialog open={opened !== null} onOpenChange={open => !open && setOpened(null)}>
        <DialogContent className="max-w-5xl bg-background p-2">
          <DialogTitle className="sr-only">
            {opened?.original_filename ?? 'Photo viewer'}
          </DialogTitle>
          {opened && (
            <PhotoViewer
              photo={opened}
              slug={slug}
              eventId={eventId}
              onClose={() => setOpened(null)}
            />
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
  onDelete: () => void
  deleting: boolean
}) {
  const isFigma = photo.kind === 'figma'

  return (
    <div className="group relative overflow-hidden rounded-md border bg-muted">
      <button type="button" onClick={onOpen} className="block w-full">
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
            alt={photo.original_filename}
            className="aspect-square w-full object-cover"
            loading="lazy"
          />
        )}
      </button>
      <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
        <span className="truncate text-xs text-white" title={photo.original_filename}>
          {photo.original_filename || (isFigma ? 'Figma frame' : 'photo')}
        </span>
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
  onClose,
}: {
  photo: EventPhoto
  slug: string
  eventId: string
  onClose: () => void
}) {
  const isFigma = photo.kind === 'figma'

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
            alt={photo.original_filename}
            className="max-h-[75vh] w-full object-contain"
          />
        )}
        <Button
          size="icon"
          variant="outline"
          className="absolute right-2 top-2 h-8 w-8"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </Button>
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
      <CommentThread slug={slug} eventId={eventId} photoId={photo.id} />
    </div>
  )
}

function CommentThread({
  slug,
  eventId,
  photoId,
}: {
  slug: string
  eventId: string
  photoId: string
}) {
  const queryClient = useQueryClient()
  const [body, setBody] = useState('')
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const key = ['eventPhotoComments', slug, eventId, photoId]

  const commentsQuery = useQuery({
    queryKey: key,
    queryFn: () => eventPhotosApi.listComments(slug, eventId, photoId),
  })

  const createMut = useMutation({
    mutationFn: () => eventPhotosApi.createComment(slug, eventId, photoId, body.trim(), replyTo),
    onSuccess: () => {
      setBody('')
      setReplyTo(null)
      void queryClient.invalidateQueries({ queryKey: key })
    },
  })

  const deleteMut = useMutation({
    mutationFn: (commentId: string) =>
      eventPhotosApi.deleteComment(slug, eventId, photoId, commentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: key })
    },
  })

  const comments = commentsQuery.data ?? []
  const topLevel = comments.filter(comment => comment.parent_id === null)
  const repliesByParent = new Map<string, EventPhotoComment[]>()
  for (const comment of comments) {
    if (comment.parent_id) {
      const list = repliesByParent.get(comment.parent_id) ?? []
      list.push(comment)
      repliesByParent.set(comment.parent_id, list)
    }
  }

  return (
    <div className="flex h-full min-h-[400px] flex-col rounded-md border bg-card p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <MessageCircle className="h-4 w-4 text-muted-foreground" />
        Comments
        <span className="text-xs font-normal text-muted-foreground">
          ({comments.length})
        </span>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto pr-1 text-sm">
        {commentsQuery.isLoading ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : topLevel.length === 0 ? (
          <div className="text-xs text-muted-foreground">
            No comments yet. Start the thread.
          </div>
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
      <form
        className="mt-3 flex flex-col gap-2 border-t pt-3"
        onSubmit={event => {
          event.preventDefault()
          if (!body.trim()) return
          createMut.mutate()
        }}
      >
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
        <label htmlFor="comment-body" className="sr-only">Write a comment</label>
        <textarea
          id="comment-body"
          value={body}
          onChange={event => setBody(event.target.value)}
          placeholder="Write a comment…"
          className="min-h-[60px] w-full rounded-md border bg-background px-2 py-1 text-sm"
        />
        <div className="flex items-center justify-end gap-2">
          <Button
            type="submit"
            size="sm"
            disabled={!body.trim() || createMut.isPending}
          >
            {createMut.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {replyTo ? 'Reply' : 'Comment'}
          </Button>
        </div>
      </form>
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
  comment: EventPhotoComment
  replies: EventPhotoComment[]
  onReply: () => void
  onDelete: (id: string) => void
  replyingTo: string | null
}) {
  return (
    <div className="space-y-2">
      <div className="rounded-md border bg-muted/30 px-2 py-1.5">
        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>{new Date(comment.created_at).toLocaleString()}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="hover:text-foreground"
              onClick={onReply}
            >
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
                <span>{new Date(reply.created_at).toLocaleString()}</span>
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
