import { describe, expect, it } from 'vitest'

import { readDeliveryFilters } from './deliveryFilters'

const ID = '3f2a9c1e-8b7d-4e6f-9a0b-1c2d3e4f5a6b'

describe('readDeliveryFilters — ids', () => {
  it('drops ids that are not UUIDs, which the API would 422', () => {
    const filters = readDeliveryFilters(
      new URLSearchParams('delivery_destination=bogus&delivery_rule=3f2a9c1e-8b7d'),
      'not-a-uuid',
    )
    expect(filters.destination_id).toBe('')
    expect(filters.rule_id).toBe('')
    expect(filters.scan_config_id).toBe('')
  })

  it('keeps well-formed ids, trimmed', () => {
    const filters = readDeliveryFilters(
      new URLSearchParams(`delivery_destination=${ID}&delivery_rule=%20${ID.toUpperCase()}%20`),
      ID,
    )
    expect(filters.destination_id).toBe(ID)
    expect(filters.rule_id).toBe(ID.toUpperCase())
    expect(filters.scan_config_id).toBe(ID)
  })
})
