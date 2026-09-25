import { SCard } from '@/components/settings/kit'
import { METRIC_TEMPLATES, type MetricTemplate } from './metricTemplates'

interface TemplateGalleryProps {
  onPick: (template: MetricTemplate) => void
  onSkip: () => void
}

/**
 * Create-only starter gallery: a compact grid of metric templates that prefill
 * the form, plus a "Start from scratch" escape hatch. Cards are plain buttons
 * (keyboard-focusable) styled to match the RadioCards / SCard idiom; picking one
 * seeds the form and dismisses the gallery, leaving every field editable.
 */
export function TemplateGallery({ onPick, onSkip }: TemplateGalleryProps) {
  return (
    <SCard
      title="Start from a template"
      description="Prefill the form for a common metric, then point it at your data — or start from scratch."
    >
      <div className="px-4 py-4">
        <div
          role="group"
          aria-label="Metric templates"
          className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
        >
          {METRIC_TEMPLATES.map(template => {
            const Icon = template.icon
            return (
              <button
                key={template.id}
                type="button"
                onClick={() => onPick(template)}
                className="flex items-start gap-2.5 rounded-card px-[13px] py-[11px] text-left transition-colors hover:bg-[var(--surface-hover)]"
                style={{ border: '1px solid var(--border)', background: 'var(--bg)' }}
              >
                <span
                  className="mt-px flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-lg"
                  style={{
                    background: 'var(--bg-sunken)',
                    border: '1px solid var(--border-subtle)',
                    color: 'var(--fg-muted)',
                  }}
                >
                  <Icon size={16} />
                </span>
                <span className="min-w-0">
                  <span
                    className="block text-body-sm font-semibold"
                    style={{ color: 'var(--fg)' }}
                  >
                    {template.label}
                  </span>
                  <span
                    className="mt-0.5 block text-caption leading-[1.4]"
                    style={{ color: 'var(--fg-subtle)' }}
                  >
                    {template.description}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
        <div className="mt-[14px]">
          <button
            type="button"
            onClick={onSkip}
            className="inline-flex h-8 items-center rounded-control px-3 text-body-sm font-medium transition-colors hover:bg-[var(--surface-hover)]"
            style={{ border: '1px solid var(--border)', color: 'var(--fg-muted)' }}
          >
            Start from scratch
          </button>
        </div>
      </div>
    </SCard>
  )
}
