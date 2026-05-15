import { Bookmark, Check, Save, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { EventsSavedView } from './savedViews'

export function SavedViewsMenu({
  views,
  activeViewName,
  draftName,
  onDraftNameChange,
  onSave,
  onApply,
  onDelete,
}: {
  views: EventsSavedView[]
  activeViewName: string | null
  draftName: string
  onDraftNameChange: (value: string) => void
  onSave: () => void
  onApply: (view: EventsSavedView) => void
  onDelete: (name: string) => void
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 text-xs">
          <Bookmark className="h-3 w-3" />
          Views
          {activeViewName && (
            <span className="max-w-24 truncate text-[10.5px] text-muted-foreground">
              {activeViewName}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <div
          className="px-1 pb-2 text-[10.5px] font-semibold uppercase tracking-[0.06em]"
          style={{ color: 'var(--fg-subtle)' }}
        >
          Saved views
        </div>
        <div className="mb-2 flex gap-1">
          <Input
            aria-label="Saved view name"
            value={draftName}
            onChange={event => onDraftNameChange(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter') onSave()
            }}
            placeholder="Current filters as..."
            className="h-8 text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={onSave}
            disabled={!draftName.trim()}
            aria-label="Save current view"
          >
            <Save className="h-3.5 w-3.5" />
          </Button>
        </div>

        {views.length === 0 ? (
          <div className="rounded border border-dashed px-2 py-3 text-center text-[12px] text-muted-foreground">
            No saved views
          </div>
        ) : (
          <div className="max-h-64 overflow-auto">
            {views.map(view => {
              const isActive = view.name === activeViewName
              return (
                <div
                  key={view.name}
                  className="flex items-center gap-1 rounded px-1 py-1 hover:bg-[var(--surface-hover)]"
                >
                  <button
                    type="button"
                    onClick={() => onApply(view)}
                    className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-1 text-left text-[12px]"
                  >
                    <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                      {isActive && <Check className="h-3 w-3" />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{view.name}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">{view.tab}</span>
                  </button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-muted-foreground"
                    onClick={() => onDelete(view.name)}
                    aria-label={`Delete saved view ${view.name}`}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              )
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
