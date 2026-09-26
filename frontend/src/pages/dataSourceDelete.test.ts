import { describe, expect, it } from 'vitest'

import type { DataSource } from '@/types'
import {
  dataSourceDeleteMessage,
  dataSourceDeleteRequireText,
  dataSourceUsageLabel,
} from './dataSourceDelete'

const SOURCE = { name: 'Warehouse' } as DataSource

describe('dataSourceDeleteMessage (DA-40)', () => {
  it('counts the scans and runs that go with the source', () => {
    expect(dataSourceDeleteMessage({ ...SOURCE, scan_count: 1, scan_run_count: 12 })).toBe(
      'Delete "Warehouse"? 1 scan and 12 runs will be removed with it.',
    )
  })

  it('says nothing else goes when no scan reads it', () => {
    expect(dataSourceDeleteMessage({ ...SOURCE, scan_count: 0, scan_run_count: 0 })).toBe(
      'Delete "Warehouse"? No scan reads it, so nothing else is removed.',
    )
  })

  it('names the loss without numbers when the server sent none', () => {
    expect(dataSourceDeleteMessage(SOURCE)).toBe(
      'Delete "Warehouse"? All associated scans and their runs will be removed.',
    )
  })
})

describe('dataSourceUsageLabel (DA-40)', () => {
  it('counts the scans that read the source', () => {
    expect(dataSourceUsageLabel({ ...SOURCE, scan_count: 1 })).toBe('Used by 1 scan')
    expect(dataSourceUsageLabel({ ...SOURCE, scan_count: 3 })).toBe('Used by 3 scans')
  })

  it('says so when no scan reads it', () => {
    expect(dataSourceUsageLabel({ ...SOURCE, scan_count: 0 })).toBe('Not used by any scan')
  })

  it('shows nothing when the server sent no count', () => {
    expect(dataSourceUsageLabel(SOURCE)).toBeNull()
  })
})

describe('dataSourceDeleteRequireText (DA-40)', () => {
  it('asks for the name when scans read the source', () => {
    expect(dataSourceDeleteRequireText({ ...SOURCE, scan_count: 2 })).toBe('Warehouse')
  })

  it('keeps the plain confirm when nothing reads it or the count is unknown', () => {
    expect(dataSourceDeleteRequireText({ ...SOURCE, scan_count: 0 })).toBeUndefined()
    expect(dataSourceDeleteRequireText(SOURCE)).toBeUndefined()
  })
})
