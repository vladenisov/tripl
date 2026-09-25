import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { projectsApi } from '@/api/projects'
import { ErrorState } from '@/components/error-state'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { projectsKey } from '@/lib/queryKeys'
import { SLUG_ERROR, SLUG_HINT, isValidSlug, slugify } from '@/lib/slug'

/**
 * The workspace page's "Create project" dialog.
 *
 * The page mounts it only while it is open, so closing it (Cancel, Esc, the
 * overlay) throws the whole draft away: the fields, the "slug edited by hand"
 * flag and the last failed attempt. Reopening used to bring back the old name
 * and the old "Could not create project" error, with auto-slug switched off
 * for good (WS-18).
 */
export function CreateProjectDialog({
  onClose,
  existingSlugs,
}: {
  onClose: () => void
  /** Slugs already taken, so a name with no Latin letters gets a free `project-<n>`. */
  existingSlugs: readonly string[]
}) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [description, setDescription] = useState('')
  const [submitted, setSubmitted] = useState(false)

  const createMut = useMutation({
    // The dialog renders its own ErrorState, so the global toast stays quiet.
    meta: SILENT_ERROR_META,
    mutationFn: () => projectsApi.create({ name, slug, description }),
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: projectsKey() })
      // Enter the freshly-created project instead of stranding the user on the
      // workspace list — mirrors the demo path's success routing (tripl-q7i1.8).
      void navigate(`/p/${created.slug}/overview`)
      onClose()
    },
  })

  const slugValid = isValidSlug(slug)
  // Said once the user has typed a slug or tried to submit, not while the
  // first keystroke of the name is still deriving one.
  const showSlugError = !slugValid && (submitted || (slugTouched && slug.length > 0))

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent>
        <form
          // No native `pattern`: its generic "Please match the requested
          // format" tooltip never said what the format was (WS-17). The rule
          // is shown under the field instead.
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            setSubmitted(true)
            if (!name.trim() || !slugValid || createMut.isPending) return
            createMut.mutate()
          }}
        >
          <DialogHeader>
            <DialogTitle>Create project</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="project-name">Project name</Label>
              <Input
                id="project-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value)
                  if (!slugTouched) setSlug(slugify(event.target.value, existingSlugs))
                }}
                placeholder="My Project"
                aria-invalid={(submitted && !name.trim()) || undefined}
                aria-describedby={submitted && !name.trim() ? 'project-name-error' : undefined}
                required
              />
              {submitted && !name.trim() && (
                <p id="project-name-error" className="m-0 text-[12px]" style={{ color: 'var(--danger)' }}>
                  Give the project a name.
                </p>
              )}
            </div>
            <div className="grid gap-2">
              <Label htmlFor="project-slug">Slug (url-friendly)</Label>
              <Input
                id="project-slug"
                value={slug}
                onChange={(event) => {
                  setSlugTouched(true)
                  setSlug(event.target.value)
                }}
                className="font-mono"
                aria-invalid={showSlugError || undefined}
                aria-describedby="project-slug-hint"
                required
              />
              <p
                id="project-slug-hint"
                className="m-0 text-[12px]"
                style={{ color: showSlugError ? 'var(--danger)' : 'var(--fg-subtle)' }}
              >
                {showSlugError ? SLUG_ERROR : SLUG_HINT}
              </p>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="project-desc">Description (optional)</Label>
              <Textarea
                id="project-desc"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={2}
              />
            </div>
            {createMut.isError && (
              <ErrorState compact title="Could not create project" error={createMut.error} />
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={createMut.isPending}>
              {createMut.isPending ? 'Creating…' : 'Create'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
