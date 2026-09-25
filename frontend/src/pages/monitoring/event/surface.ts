/** Shared surface styles of the event-detail cards (mockup EventDetailPage). */
export const SURFACE_CARD = 'overflow-hidden rounded-card border'
export const SURFACE_STYLE = { background: 'var(--surface)', borderColor: 'var(--border)' } as const

// Statuses whose event has data behind it, so the chart may lead the page.
export const LIVE_STATUSES = new Set<string>(['live', 'deprecated', 'archived'])
