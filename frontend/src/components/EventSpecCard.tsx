import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Copy } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useActiveBranchId, useBranchLinkProps } from '@/hooks/useBranch'
import { resolveMetaFieldHref } from '@/lib/metaFields'
import { buildExamplePayload, buildSpecMarkdown, specIdentity, type SpecRow } from '@/lib/eventSpec'
import { nameFormatBaseColumns } from '@/pages/events/utils'
import type { Event, EventType, MetaFieldDefinition } from '@/types'

const CARD = 'overflow-hidden rounded-[10px] border'
const CARD_STYLE = { background: 'var(--surface)', borderColor: 'var(--border)' } as const
const TH = 'px-[14px] py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.04em] text-[var(--fg-subtle)]'
const TD = 'px-[14px] py-[9px] text-[12.5px] align-top'

async function copyText(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(`${what} copied`)
  } catch {
    toast.error(`Could not copy ${what.toLowerCase()}`)
  }
}

/**
 * What a developer needs to instrument an event, on the page they are sent to.
 *
 * The monitoring detail page was built for watching a live event; a developer
 * handed a branch link found a Russian title, an identity reconstructible only
 * from the Fields table, template placeholders with no documented values in
 * sight, and half a page of "No metrics data available" for an event that is
 * not built yet (tripl-kjhi.8). This card is the spec: identity with copy,
 * the fields with the marks that matter to an implementer, the documented
 * values inline, an example payload, and a Markdown copy for the ticket.
 */
export function EventSpecCard({
  slug,
  event,
  eventType,
  metaFieldMap,
}: {
  slug: string
  event: Event
  eventType: EventType | undefined
  metaFieldMap: Map<string, MetaFieldDefinition>
}) {
  const branchId = useActiveBranchId()
  const branchLink = useBranchLinkProps()
  const identity = specIdentity(event)
  const rule = eventType?.event_name_format ?? null
  const rows = useMemo<SpecRow[]>(() => {
    const naming = nameFormatBaseColumns(rule)
    const valueByField = new Map(event.field_values.map(fv => [fv.field_definition_id, fv]))
    return [...(eventType?.field_definitions ?? [])]
      .sort((a, b) => a.order - b.order)
      .map(field => {
        const fv = valueByField.get(field.id)
        return {
          field,
          value: fv?.value ?? '',
          namesTheEvent: naming.has(field.name),
          contexts: fv?.variable_values ?? [],
        }
      })
  }, [event.field_values, eventType?.field_definitions, rule])
  const payload = useMemo(() => buildExamplePayload(rows), [rows])
  const payloadJson = JSON.stringify(payload, null, 2)
  const markdown = () =>
    buildSpecMarkdown({
      identity,
      title: event.title,
      eventTypeName: eventType?.display_name,
      description: event.description,
      rule,
      rows,
      payload,
    })

  return (
    <section className={CARD} style={CARD_STYLE} aria-label="Spec" data-testid="event-spec-card">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <span className="text-[12.5px] font-semibold">Spec</span>
        <span className="text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
          what to send, and where it must land
        </span>
        <div className="flex-1" />
        <Button variant="outline" size="sm" onClick={() => copyText(payloadJson, 'JSON')}>
          <Copy className="mr-1.5 h-3.5 w-3.5" />
          Copy as JSON
        </Button>
        <Button variant="outline" size="sm" onClick={() => copyText(markdown(), 'Markdown')}>
          <Copy className="mr-1.5 h-3.5 w-3.5" />
          Copy as Markdown
        </Button>
      </div>

      <div className="space-y-2 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <code className="mono text-[13px] font-medium" data-testid="spec-identity">{identity}</code>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-1.5"
            aria-label="Copy identity"
            onClick={() => copyText(identity, 'Identity')}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
          {eventType && (
            <span className="text-[11.5px]" style={{ color: 'var(--fg-muted)' }}>{eventType.display_name}</span>
          )}
        </div>
        {event.title && <p className="text-[13px]">{event.title}</p>}
        {rule && (
          <p className="text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
            Named by scan rule <span className="mono">{rule}</span>. The scan matches this event on the
            identity above, so the row must carry exactly these values.
          </p>
        )}
        {event.description && (
          <p className="whitespace-pre-wrap text-[12.5px]" style={{ color: 'var(--fg-muted)' }}>{event.description}</p>
        )}
        {(event.tags.length > 0 || event.meta_values.length > 0) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px]" style={{ color: 'var(--fg-muted)' }}>
            {event.tags.map(tag => (
              <span key={tag.id} className="mono">#{tag.name}</span>
            ))}
            {event.meta_values.map(mv => {
              const def = metaFieldMap.get(mv.meta_field_definition_id)
              if (!def || !mv.value) return null
              const href = resolveMetaFieldHref(def, mv.value)
              return (
                <span key={mv.id}>
                  {def.display_name}:{' '}
                  {href ? (
                    <a href={href} target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--accent)' }}>
                      {mv.value}
                    </a>
                  ) : (
                    <span className="mono">{mv.value}</span>
                  )}
                </span>
              )
            })}
          </div>
        )}
      </div>

      {rows.length > 0 && (
        <div className="overflow-x-auto border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          <table className="w-full border-collapse" aria-label="Spec fields">
            <thead>
              <tr style={{ background: 'var(--bg-sunken)' }}>
                <th scope="col" className={TH}>Field</th>
                <th scope="col" className={TH}>Type</th>
                <th scope="col" className={TH}>Value</th>
                <th scope="col" className={TH}>Documented values</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.field.id} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                  <td className={TD}>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="mono text-[12px]">{row.field.name}</span>
                      {(row.field.is_required || row.namesTheEvent) && (
                        <span className="text-[10.5px]" style={{ color: 'var(--danger)' }}>required</span>
                      )}
                      {row.namesTheEvent && (
                        <span
                          className="rounded-sm px-1 text-[10px]"
                          style={{ background: 'var(--bg-sunken)', color: 'var(--fg-subtle)' }}
                        >
                          names the event
                        </span>
                      )}
                    </div>
                    {row.field.description && (
                      <div className="mt-[2px] text-[11px]" style={{ color: 'var(--fg-subtle)' }}>{row.field.description}</div>
                    )}
                  </td>
                  <td className={`${TD} mono text-[11.5px]`}>{row.field.field_type}</td>
                  <td className={`${TD} mono break-all text-[11.5px]`} style={{ color: 'var(--fg-muted)' }}>
                    {row.value || '—'}
                  </td>
                  <td className={`${TD} text-[11.5px]`}>
                    {row.contexts.length === 0 ? (
                      <span style={{ color: 'var(--fg-subtle)' }}>—</span>
                    ) : (
                      <ul className="space-y-1">
                        {row.contexts.map(context => {
                          const link = branchLink(`/p/${slug}/variables/${context.variable_id}`, branchId)
                          return (
                            <li key={context.id}>
                              <Link to={link.to} onClick={link.onClick} className="mono underline underline-offset-2">
                                ${'{'}{context.variable_name}{'}'}
                              </Link>
                              {context.values.length > 0 ? (
                                <span className="mono" style={{ color: 'var(--fg-muted)' }}>
                                  {' '}= {context.values.slice(0, 10).join(', ')}
                                  {context.values.length > 10 ? ` … +${context.values.length - 10}` : ''}
                                </span>
                              ) : (
                                <span style={{ color: 'var(--fg-subtle)' }}> — no documented values yet</span>
                              )}
                            </li>
                          )
                        })}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="border-t px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.04em]" style={{ color: 'var(--fg-subtle)' }}>
          Example payload
        </div>
        <pre className="mono overflow-x-auto rounded-md p-3 text-[11.5px]" style={{ background: 'var(--bg-sunken)' }} data-testid="spec-payload">
          {payloadJson}
        </pre>
      </div>
    </section>
  )
}
