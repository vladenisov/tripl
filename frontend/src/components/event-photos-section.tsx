import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { eventPhotosApi } from '@/api/eventPhotos'
import type { EventPhoto } from '@/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { ImagePlus, Loader2, Trash2, Upload, X } from 'lucide-react'

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

export default function EventPhotosSection({ slug, eventId }: Props) {
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [lightbox, setLightbox] = useState<EventPhoto | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const photosKey = ['eventPhotos', slug, eventId]
  const photosQuery = useQuery({
    queryKey: photosKey,
    queryFn: () => eventPhotosApi.list(slug, eventId),
    enabled: !!slug && !!eventId,
  })

  const uploadMut = useMutation({
    mutationFn: async (files: File[]) => {
      // Sequential upload keeps the order predictable and avoids overwhelming
      // the storage backend with N parallel requests.
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

  const deleteMut = useMutation({
    mutationFn: (photoId: string) => eventPhotosApi.delete(slug, eventId, photoId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: photosKey })
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
        <div className="mb-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ImagePlus className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-lg font-semibold">Photos</h2>
            <span className="text-xs text-muted-foreground">({photos.length})</span>
          </div>
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
            Upload
          </Button>
        </div>

        <div
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
              <div>Drop images here or click <span className="font-medium">Upload</span></div>
              <div className="text-xs">JPEG, PNG, GIF, or WebP</div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {photos.map(photo => (
                <div
                  key={photo.id}
                  className="group relative overflow-hidden rounded-md border bg-muted"
                >
                  <button
                    type="button"
                    onClick={() => setLightbox(photo)}
                    className="block w-full"
                  >
                    <img
                      src={photo.url}
                      alt={photo.original_filename}
                      className="aspect-square w-full object-cover"
                      loading="lazy"
                    />
                  </button>
                  <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100">
                    <span className="truncate text-xs text-white" title={photo.original_filename}>
                      {photo.original_filename || 'photo'}
                    </span>
                    <Button
                      size="icon"
                      variant="destructive"
                      className="h-7 w-7 shrink-0"
                      disabled={deleteMut.isPending}
                      onClick={event => {
                        event.stopPropagation()
                        if (window.confirm('Delete this photo?')) {
                          deleteMut.mutate(photo.id)
                        }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <div className="absolute right-1 top-1 rounded bg-black/50 px-1.5 py-0.5 text-[10px] text-white">
                    {formatSize(photo.size_bytes)}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && (
          <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
      </CardContent>

      <Dialog open={lightbox !== null} onOpenChange={open => !open && setLightbox(null)}>
        <DialogContent className="max-w-4xl bg-background p-2">
          {lightbox && (
            <div className="relative">
              <img
                src={lightbox.url}
                alt={lightbox.original_filename}
                className="max-h-[80vh] w-full object-contain"
              />
              <Button
                size="icon"
                variant="outline"
                className="absolute right-2 top-2 h-8 w-8"
                onClick={() => setLightbox(null)}
              >
                <X className="h-4 w-4" />
              </Button>
              <div className="px-2 pt-2 text-xs text-muted-foreground">
                {lightbox.original_filename} · {formatSize(lightbox.size_bytes)} · {lightbox.storage_backend}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  )
}
