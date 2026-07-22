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
    // An unknown surface falls back to Events but keeps the slug.
    expect(resolveTitleFromPath('/p/acme/unknown')).toEqual({ label: 'Events', slug: 'acme' })
  })

  it('labels the full-takeover Settings routes that mount outside the shell (no slug)', () => {
    expect(resolveTitleFromPath('/settings/members')).toEqual({ label: 'Members' })
    expect(resolveTitleFromPath('/settings/data-sources')).toEqual({ label: 'Data sources' })
    expect(resolveTitleFromPath('/settings/instance/runtime')).toEqual({ label: 'Instance settings' })
    expect(resolveTitleFromPath('/settings')).toEqual({ label: 'Settings' })
  })

  it('labels auth, workspace and the root, and yields a blank label for unknown paths', () => {
    expect(resolveTitleFromPath('/auth')).toEqual({ label: 'Sign in' })
    expect(resolveTitleFromPath('/')).toEqual({ label: 'Workspace' })
    expect(resolveTitleFromPath('/workspace')).toEqual({ label: 'Workspace' })
    expect(resolveTitleFromPath('/nope')).toEqual({ label: '' })
  })
})
