import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { buildDocumentTitle, resolveTitleFromPath, useDocumentTitle } from './useDocumentTitle'

const SEP = ' · '

describe('buildDocumentTitle', () => {
  it('includes the page label and project slug for a project-scoped route', () => {
    expect(buildDocumentTitle('Anomalies', 'acme')).toBe(
      `Anomalies${SEP}acme${SEP}tripl`,
    )
    expect(buildDocumentTitle('Events', 'acme')).toBe(`Events${SEP}acme${SEP}tripl`)
  })

  it('omits the slug segment when there is no active project', () => {
    expect(buildDocumentTitle('Settings')).toBe(`Settings${SEP}tripl`)
    expect(buildDocumentTitle('Settings', null)).toBe(`Settings${SEP}tripl`)
    expect(buildDocumentTitle('Settings', '')).toBe(`Settings${SEP}tripl`)
  })

  it('drops blank or whitespace-only segments so no empty separators appear', () => {
    expect(buildDocumentTitle('')).toBe('tripl')
    expect(buildDocumentTitle('   ')).toBe('tripl')
    expect(buildDocumentTitle('   ', '  ')).toBe('tripl')
  })

  it('trims surrounding whitespace on each segment', () => {
    expect(buildDocumentTitle('  Coverage  ', '  acme  ')).toBe(
      `Coverage${SEP}acme${SEP}tripl`,
    )
  })
})

describe('useDocumentTitle', () => {
  const originalTitle = document.title
  afterEach(() => {
    document.title = originalTitle
  })

  it('writes the composed title to document.title', () => {
    renderHook(() => useDocumentTitle('Metrics', 'acme'))
    expect(document.title).toBe(`Metrics${SEP}acme${SEP}tripl`)
  })

  it('updates document.title when the label or slug changes', () => {
    const { rerender } = renderHook(
      ({ label, slug }: { label: string; slug?: string }) =>
        useDocumentTitle(label, slug),
      { initialProps: { label: 'Events', slug: 'acme' } },
    )
    expect(document.title).toBe(`Events${SEP}acme${SEP}tripl`)

    rerender({ label: 'Reconciliation', slug: 'acme' })
    expect(document.title).toBe(`Reconciliation${SEP}acme${SEP}tripl`)
  })
})

describe('resolveTitleFromPath', () => {
  it('labels a project-scoped surface and carries its slug', () => {
    expect(resolveTitleFromPath('/p/acme/anomalies')).toEqual({ label: 'Anomalies', slug: 'acme' })
    expect(resolveTitleFromPath('/p/acme/overview')).toEqual({ label: 'Live activity', slug: 'acme' })
    // A bare project path lands on Events (the default surface).
    expect(resolveTitleFromPath('/p/acme')).toEqual({ label: 'Events', slug: 'acme' })
  })

  it('names an unmatched project sub-path as not-found while keeping the slug', () => {
    // tripl-jfm3.3: `/p/acme/<no-such-surface>` renders the 404 page, so the tab
    // must say so instead of inheriting the Events label. The slug is still
    // valid, so the project keeps naming the tab.
    expect(resolveTitleFromPath('/p/acme/this-route-does-not-exist')).toEqual({
      label: 'Page not found',
      slug: 'acme',
    })
    expect(resolveTitleFromPath('/p/acme/scans')).toEqual({
      label: 'Page not found',
      slug: 'acme',
    })
  })

  it('keeps redirect-only surfaces on a real label so they never flash not-found', () => {
    expect(resolveTitleFromPath('/p/acme/alerting')).toEqual({ label: 'Alerting', slug: 'acme' })
    expect(resolveTitleFromPath('/p/acme/fact-tables')).toEqual({
      label: 'Fact tables',
      slug: 'acme',
    })
    expect(resolveTitleFromPath('/data-sources')).toEqual({ label: 'Data sources' })
    expect(resolveTitleFromPath('/account')).toEqual({ label: 'Profile' })
  })

  it('labels a sub-surface that is its own destination rather than its parent surface', () => {
    // Sidebar destinations that happen to be routed under /settings/.
    expect(resolveTitleFromPath('/p/acme/settings/event-types')).toEqual({
      label: 'Event types',
      slug: 'acme',
    })
    expect(resolveTitleFromPath('/p/acme/settings/meta-fields')).toEqual({
      label: 'Schema & fields',
      slug: 'acme',
    })
    expect(resolveTitleFromPath('/p/acme/metrics/fact-tables')).toEqual({
      label: 'Fact tables',
      slug: 'acme',
    })
    // Deeper segments (detail ids, editors) inherit the sub-surface label.
    expect(resolveTitleFromPath('/p/acme/settings/event-types/abc123')).toEqual({
      label: 'Event types',
      slug: 'acme',
    })
    expect(resolveTitleFromPath('/p/acme/metrics/fact-tables/new')).toEqual({
      label: 'Fact tables',
      slug: 'acme',
    })
  })

  it('keeps project configuration tabs on the parent settings label', () => {
    expect(resolveTitleFromPath('/p/acme/settings/general')).toEqual({
      label: 'Project settings',
      slug: 'acme',
    })
    expect(resolveTitleFromPath('/p/acme/settings/monitoring')).toEqual({
      label: 'Project settings',
      slug: 'acme',
    })
    // `/events/event-types` is not a real route: it matches the Events tab
    // pattern and renders a filtered catalog, so it must stay on "Events".
    expect(resolveTitleFromPath('/p/acme/events/event-types')).toEqual({
      label: 'Events',
      slug: 'acme',
    })
  })

  it('keeps every other sub-path of a surface on the parent surface label', () => {
    // Events tabs are filtered views of the same catalog, not their own surface.
    expect(resolveTitleFromPath('/p/acme/events')).toEqual({ label: 'Events', slug: 'acme' })
    expect(resolveTitleFromPath('/p/acme/events/review')).toEqual({ label: 'Events', slug: 'acme' })
    expect(resolveTitleFromPath('/p/acme/events/archived')).toEqual({ label: 'Events', slug: 'acme' })
    // A per-event-type tab, and an event opened from one, are still Events.
    expect(resolveTitleFromPath('/p/acme/events/checkout_completed')).toEqual({
      label: 'Events',
      slug: 'acme',
    })
    expect(resolveTitleFromPath('/p/acme/events/all/42')).toEqual({ label: 'Events', slug: 'acme' })
    // The metric editors stay on Metrics.
    expect(resolveTitleFromPath('/p/acme/metrics')).toEqual({ label: 'Metrics', slug: 'acme' })
    expect(resolveTitleFromPath('/p/acme/metrics/new')).toEqual({ label: 'Metrics', slug: 'acme' })
  })

  it('labels the full-takeover Settings routes that mount outside the shell (no slug)', () => {
    expect(resolveTitleFromPath('/settings/members')).toEqual({ label: 'Members' })
    expect(resolveTitleFromPath('/settings/data-sources')).toEqual({ label: 'Data sources' })
    expect(resolveTitleFromPath('/settings/instance/runtime')).toEqual({ label: 'Instance settings' })
    expect(resolveTitleFromPath('/settings')).toEqual({ label: 'Settings' })
  })

  it('labels auth, workspace and the root, and names unmatched paths not-found', () => {
    expect(resolveTitleFromPath('/auth')).toEqual({ label: 'Sign in' })
    expect(resolveTitleFromPath('/')).toEqual({ label: 'Workspace' })
    expect(resolveTitleFromPath('/workspace')).toEqual({ label: 'Workspace' })
    expect(resolveTitleFromPath('/nope')).toEqual({ label: 'Page not found' })
    expect(buildDocumentTitle(resolveTitleFromPath('/nope').label)).toBe(
      `Page not found${SEP}tripl`,
    )
  })
})
