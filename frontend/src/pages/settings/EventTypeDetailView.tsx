import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { eventTypesApi } from '@/api/eventTypes'
import { useActiveBranchId } from '@/hooks/useBranch'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { FieldsEditor, OwnersEditor } from './EventTypesTab'

export function EventTypeDetail({ slug, eventTypeId }: { slug: string; eventTypeId: string }) {
  const navigate = useNavigate()
  const branchId = useActiveBranchId()

  const { data: eventTypes = [], isSuccess } = useQuery({
    queryKey: ['eventTypes', slug, branchId],
    queryFn: () => eventTypesApi.list(slug, branchId),
  })

  const et = eventTypes.find(e => e.id === eventTypeId)

  const goBack = () => navigate(`/p/${slug}/settings/event-types`)

  if (isSuccess && !et) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={goBack} className="gap-1.5">
          <ArrowLeft className="h-4 w-4" />
          Back to Event Types
        </Button>
        <p className="text-sm text-muted-foreground">Event type not found.</p>
      </div>
    )
  }

  if (!et) {
    return null
  }

  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" onClick={goBack} className="gap-1.5">
        <ArrowLeft className="h-4 w-4" />
        Back to Event Types
      </Button>

      <div className="flex items-center gap-3">
        <span className="h-4 w-4 rounded-full shrink-0" style={{ backgroundColor: et.color }} />
        <h2 className="text-lg font-semibold">{et.display_name}</h2>
        <Badge variant="secondary" className="font-mono text-xs">{et.name}</Badge>
        {et.description && (
          <span className="text-sm text-muted-foreground">{et.description}</span>
        )}
      </div>

      <FieldsEditor slug={slug} eventType={et} branchId={branchId} />
      {branchId === null && <OwnersEditor slug={slug} eventType={et} />}
    </div>
  )
}
