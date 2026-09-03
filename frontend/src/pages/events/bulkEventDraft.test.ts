import { describe, expect, it } from 'vitest'
import { bulkUnsupportedReason, parseBulkDraft } from './bulkEventDraft'

describe('parseBulkDraft', () => {
  it('names each line by the scan rule, in the order the format reads its columns', () => {
    const rows = parseBulkDraft('settings\tunit_change\twind_speed\nspot\topen\tmodels', {
      columns: ['category', 'action', 'label'],
      nameFormat: '{category}:{action}:{label}',
    })

    expect(rows.map(row => row.name)).toEqual([
      'settings:unit_change:wind_speed',
      'spot:open:models',
    ])
    expect(rows.every(row => row.status === 'ready')).toBe(true)
  })

  it('takes a comma when there is no tab, and the whole line when one column is enough', () => {
    const commas = parseBulkDraft('settings, unit_change, wind_speed', {
      columns: ['category', 'action', 'label'],
      nameFormat: '{category}:{action}:{label}',
    })
    expect(commas[0].name).toBe('settings:unit_change:wind_speed')

    // A single-column format must NOT split: `{page}` names events after paths
    // that carry commas, and splitting would tear them apart.
    const single = parseBulkDraft('/buoy/2758a8b1,Tregde+A', {
      columns: ['page'],
      nameFormat: '{page}',
    })
    expect(single[0].name).toBe('/buoy/2758a8b1,Tregde+A')
  })

  it('reports a line that leaves a naming column empty rather than naming it half', () => {
    const rows = parseBulkDraft('settings\tunit_change', {
      columns: ['category', 'action', 'label'],
      nameFormat: '{category}:{action}:{label}',
    })

    expect(rows[0].status).toBe('incomplete')
    expect(rows[0].missing).toEqual(['label'])
  })

  it('counts blank lines so the reported line number is the one on screen', () => {
    const rows = parseBulkDraft('\n\nsign_up\n\nsign_out', {
      columns: ['action'],
      nameFormat: '{action}',
    })

    expect(rows.map(row => row.line)).toEqual([3, 5])
  })

  it('marks a repeat within the paste, and a name the catalog already holds', () => {
    const rows = parseBulkDraft('sign_up\nsign_up\nsign_out', {
      columns: ['action'],
      nameFormat: '{action}',
      taken: new Set(['sign_out']),
    })

    expect(rows.map(row => row.status)).toEqual(['ready', 'duplicate', 'exists'])
  })

  it('takes one name per line where no rule governs the type', () => {
    const rows = parseBulkDraft('checkout:started\ncheckout:completed', {
      columns: [],
      nameFormat: null,
    })

    expect(rows.map(row => row.name)).toEqual(['checkout:started', 'checkout:completed'])
    expect(rows.every(row => row.status === 'ready')).toBe(true)
  })
})

describe('bulkUnsupportedReason', () => {
  it('refuses a format that reads inside a JSON field', () => {
    const reason = bulkUnsupportedReason({
      nameFormat: 'pv:{page_data.variant}',
      namingColumns: ['page_data'],
      requiredFields: [],
    })
    expect(reason).toMatch(/inside a JSON field/)
  })

  it('refuses a type whose required fields the paste cannot fill', () => {
    const reason = bulkUnsupportedReason({
      nameFormat: '{action}',
      namingColumns: ['action'],
      requiredFields: ['action', 'platform'],
    })
    // Only the one the paste cannot supply is named; `action` is a naming column.
    expect(reason).toMatch(/needs platform/)
  })

  it('allows a type whose required fields are exactly the naming columns', () => {
    expect(
      bulkUnsupportedReason({
        nameFormat: '{action}',
        namingColumns: ['action'],
        requiredFields: ['action'],
      }),
    ).toBeNull()
  })
})
