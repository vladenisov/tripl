import { describe, expect, it } from 'vitest'
import {
  deleteEventsSavedView,
  loadEventsSavedViews,
  saveEventsSavedView,
} from './savedViews'

describe('events saved views storage', () => {
  it('stores saved filter snapshots per project slug', () => {
    saveEventsSavedView('demo-saved-a', {
      name: 'Needs review',
      tab: 'review',
      params: 'q=checkout&implemented=false',
    })
    saveEventsSavedView('other-saved-a', {
      name: 'Archived',
      tab: 'archived',
      params: 'tag=legacy',
    })

    expect(loadEventsSavedViews('demo-saved-a')).toMatchObject([
      {
        name: 'Needs review',
        tab: 'review',
        params: 'q=checkout&implemented=false',
      },
    ])
    expect(loadEventsSavedViews('other-saved-a')).toMatchObject([
      {
        name: 'Archived',
        tab: 'archived',
        params: 'tag=legacy',
      },
    ])
  })

  it('overwrites and deletes saved views by name', () => {
    saveEventsSavedView('demo-saved-b', { name: 'Default', tab: 'all', params: 'q=old' })
    saveEventsSavedView('demo-saved-b', { name: 'Default', tab: 'all', params: 'q=new' })

    expect(loadEventsSavedViews('demo-saved-b')).toMatchObject([
      { name: 'Default', tab: 'all', params: 'q=new' },
    ])

    expect(deleteEventsSavedView('demo-saved-b', 'Default')).toEqual([])
    expect(loadEventsSavedViews('demo-saved-b')).toEqual([])
  })
})
