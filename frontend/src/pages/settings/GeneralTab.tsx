import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { projectsApi } from '@/api/projects'
import { searchApi } from '@/api/search'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { RefreshCw, Trash2 } from 'lucide-react'
import { useConfirm } from '@/hooks/useConfirm'
import { getErrorMessage } from '@/lib/utils'

export function GeneralTab({ slug }: { slug: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { confirm, dialog } = useConfirm()
  const projectQuery = useQuery({
    queryKey: ['project', slug],
    queryFn: () => projectsApi.get(slug),
  })

  const [name, setName] = useState('')
  const [slugDraft, setSlugDraft] = useState('')
  const [description, setDescription] = useState('')
  const [hydratedFor, setHydratedFor] = useState<string | null>(null)

  if (projectQuery.data && hydratedFor !== projectQuery.data.id) {
    setName(projectQuery.data.name)
    setSlugDraft(projectQuery.data.slug)
    setDescription(projectQuery.data.description ?? '')
    setHydratedFor(projectQuery.data.id)
  }

  const updateMut = useMutation({
    mutationFn: () => projectsApi.update(slug, {
      name,
      slug: slugDraft,
      description,
    }),
    onSuccess: (project) => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      qc.invalidateQueries({ queryKey: ['project'] })
      if (project.slug !== slug) {
        navigate(`/p/${project.slug}/settings/general`, { replace: true })
      }
    },
  })
  const reindexMut = useMutation({
    mutationFn: () => searchApi.reindex(slug),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['commandPaletteSearch'] })
    },
  })
  const deleteMut = useMutation({
    mutationFn: () => projectsApi.del(slug),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] })
      navigate('/', { replace: true })
    },
  })

  const handleDelete = async () => {
    const projectName = projectQuery.data?.name ?? slug
    const ok = await confirm({
      title: 'Delete project',
      message: `Permanently delete "${projectName}"? All event types, events, fields, metrics, monitors, and history are removed. This cannot be undone.`,
      confirmLabel: 'Delete project',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate()
  }

  const slugError = !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slugDraft)
    ? 'Slug must be lowercase letters, digits, and hyphens'
    : null
  const isPristine =
    !!projectQuery.data
    && name === projectQuery.data.name
    && slugDraft === projectQuery.data.slug
    && description === (projectQuery.data.description ?? '')

  return (
    <>
      {dialog}
      {projectQuery.isLoading && (
        <p className="text-sm text-muted-foreground">Loading project…</p>
      )}
      {projectQuery.isError && (
        <p className="text-sm text-destructive">Failed to load project.</p>
      )}
      {projectQuery.data && (
        <div className="space-y-4">
          <Card>
            <CardContent className="p-4">
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  if (slugError) return
                  updateMut.mutate()
                }}
                className="space-y-3"
              >
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
                  <div className="grid gap-1.5">
                    <Label htmlFor="project-name">Name</Label>
                    <Input
                      id="project-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      required
                    />
                  </div>
                  <div className="grid gap-1.5">
                    <Label htmlFor="project-slug">Slug</Label>
                    <Input
                      id="project-slug"
                      value={slugDraft}
                      onChange={(event) => setSlugDraft(event.target.value)}
                      className="font-mono"
                      required
                    />
                  </div>
                </div>
                {slugError && slugDraft.length > 0 ? (
                  <p className="text-xs text-destructive">{slugError}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Slug is used in URLs. Lowercase letters, digits, and hyphens. Changing it rewrites all project URLs.
                  </p>
                )}
                <div className="grid gap-1.5">
                  <Label htmlFor="project-description">Description</Label>
                  <Textarea
                    id="project-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={2}
                  />
                </div>
                {updateMut.isError && (
                  <p className="text-sm text-destructive">{getErrorMessage(updateMut.error)}</p>
                )}
                <div className="flex justify-end">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={updateMut.isPending || isPristine || !!slugError}
                  >
                    {updateMut.isPending ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold">Search index</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Rebuild project search when existing events, descriptions, or fields do not appear in global search.
                </p>
                {reindexMut.isSuccess && (
                  <p className="mt-2 text-xs text-emerald-600">
                    Indexed {reindexMut.data.documents_indexed} documents
                    {reindexMut.data.embeddings_scheduled ? '; embeddings queued.' : '.'}
                  </p>
                )}
                {reindexMut.isError && (
                  <p className="mt-2 text-xs text-destructive">
                    {getErrorMessage(reindexMut.error)}
                  </p>
                )}
              </div>
              <div className="shrink-0">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => reindexMut.mutate()}
                  disabled={reindexMut.isPending}
                >
                  <RefreshCw className={reindexMut.isPending ? 'mr-2 h-3.5 w-3.5 animate-spin' : 'mr-2 h-3.5 w-3.5'} />
                  {reindexMut.isPending ? 'Rebuilding…' : 'Rebuild index'}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card style={{ borderColor: 'var(--danger)' }}>
            <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold" style={{ color: 'var(--danger)' }}>
                  Delete project
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Permanently removes this project and all of its event types, events, fields,
                  metrics, monitors, and history. This cannot be undone.
                </p>
                {deleteMut.isError && (
                  <p className="mt-2 text-xs text-destructive">{getErrorMessage(deleteMut.error)}</p>
                )}
              </div>
              <div className="shrink-0">
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    void handleDelete()
                  }}
                  disabled={deleteMut.isPending}
                >
                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                  {deleteMut.isPending ? 'Deleting…' : 'Delete project'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  )
}
