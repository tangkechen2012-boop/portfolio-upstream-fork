import { describe, expect, it } from 'vitest'
import { reconcileCustodyUnits } from './reconcile'

describe('reconcileCustodyUnits', () => {
  it('matches quantities within the configured tolerance', () => {
    expect(reconcileCustodyUnits(2, '2.000000005', 0.00000001)).toEqual({
      bookUnits: 2,
      observedUnits: '2.000000005',
      delta: 0.000000005,
      matched: true,
    })
  })

  it('reports a mismatch without changing either quantity', () => {
    expect(reconcileCustodyUnits(2, '2.25', 0.00000001)).toEqual({
      bookUnits: 2,
      observedUnits: '2.25',
      delta: 0.25,
      matched: false,
    })
  })

  it('rejects invalid or negative provider quantities', () => {
    expect(() => reconcileCustodyUnits(2, 'not-a-number', 0.1)).toThrow(/valid number/)
    expect(() => reconcileCustodyUnits(2, '-1', 0.1)).toThrow(/negative/)
  })
})

