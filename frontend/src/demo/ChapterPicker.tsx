/**
 * The chapter picker (tripl-odrj.4): every scenario chapter with a status chip,
 * one click to start or resume it. Shared between the product tour's hands-on
 * block and the demo welcome panel — presentation only, the caller owns what
 * "pick" means (start + navigate + close whatever hosted the picker).
 */

import { Check, Play, RotateCcw } from 'lucide-react'
import { Chip, type ChipTone } from '@/components/primitives/chip'
import type { ChapterListEntry, ChapterStatus } from './scenarioModel'

const STATUS_LABEL: Record<ChapterStatus, string> = {
  not_started: 'Not started',
  active: 'Active',
  completed: 'Completed',
  dismissed: 'Paused',
}

const STATUS_TONE: Record<ChapterStatus, ChipTone> = {
  not_started: 'neutral',
  active: 'accent',
  completed: 'success',
  dismissed: 'neutral',
}

function StatusIcon({ status }: { status: ChapterStatus }) {
  if (status === 'completed') return <Check className="h-3 w-3" aria-hidden="true" />
  if (status === 'active' || status === 'dismissed') {
    return <RotateCcw className="h-3 w-3" aria-hidden="true" />
  }
  return <Play className="h-3 w-3" aria-hidden="true" />
}

interface ChapterPickerProps {
  chapters: ChapterListEntry[]
  onPick: (chapter: ChapterListEntry) => void
  /** Compact rows (welcome panel) vs full rows with blurbs (tour). */
  compact?: boolean
}

export function ChapterPicker({ chapters, onPick, compact = false }: ChapterPickerProps) {
  return (
    <ol className="flex flex-col gap-1" aria-label="Scenario chapters">
      {chapters.map((chapter, index) => (
        <li key={chapter.id}>
          <button
            type="button"
            onClick={() => onPick(chapter)}
            className="flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
            style={{ background: 'var(--surface)', borderColor: 'var(--border-subtle)' }}
          >
            <span
              className="mono w-4 shrink-0 text-center text-[10.5px]"
              style={{ color: 'var(--fg-faint)' }}
              aria-hidden="true"
            >
              {index + 1}
            </span>
            <span className="flex shrink-0 items-center" style={{ color: 'var(--accent)' }}>
              <StatusIcon status={chapter.status} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[12px] font-medium">{chapter.title}</span>
              {!compact && (
                <span
                  className="block truncate text-[10.5px]"
                  style={{ color: 'var(--fg-subtle)' }}
                >
                  {chapter.blurb}
                </span>
              )}
            </span>
            <Chip tone={STATUS_TONE[chapter.status]} size="xs">
              {STATUS_LABEL[chapter.status]}
            </Chip>
          </button>
        </li>
      ))}
    </ol>
  )
}
