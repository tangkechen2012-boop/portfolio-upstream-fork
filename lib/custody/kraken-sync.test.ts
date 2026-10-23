import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { runKrakenCustodySync, type KrakenCustodySyncDependencies } from './kraken-sync'

const connection = {
  id: 'cx-1', fund_id: 'fund-1', provider: 'kraken', active: true,
  created_by: 'user-1', last_error: null,
}
const position = {
  id: 'pos-1', fund_id: 'fund-1', connection_id: 'cx-1', company_id: 'btc-company',
  vehicle_id: 'vehicle-1', price_feed_id: 'feed-1', asset_code: 'BTC', auto_book: true,
  tolerance: '0.00000001', active: true,
}

const seed = (overrides: { position?: Record<string, unknown>; transactions?: any[] } = {}) => memoryAdmin({
  custody_connections: [{ ...connection }],
  custody_positions: [{ ...position, ...overrides.position }],
  custody_balance_observations: [],
  fund_vehicles: [{ id: 'vehicle-1', fund_id: 'fund-1', name: 'KC Bitcoin Fund I, L.P.' }],
  companies: [{
    id: 'btc-company', fund_id: 'fund-1', name: 'Bitcoin', holding_type: 'crypto',
    status: 'active', industry: null, stage: null, portfolio_group: ['KC Bitcoin Fund I, L.P.'],
  }],
  investment_transactions: overrides.transactions ?? [{
    id: 'txn-1', fund_id: 'fund-1', company_id: 'btc-company', transaction_type: 'investment',
    transaction_date: '2026-10-01', portfolio_group: 'KC Bitcoin Fund I, L.P.',
    investment_cost: 100_000, shares_acquired: 2, share_price: 50_000,
  }],
})

let balances: Map<string, string>
let deps: KrakenCustodySyncDependencies
let bookResult: any

beforeEach(() => {
  balances = new Map([['BTC', '2.000000005']])
  bookResult = { booked: true, transactionId: 'mark-1', mark: {}, ledger: {} }
  deps = {
    getCredentials: vi.fn(async () => ({ apiKey: 'key', apiSecret: 'secret' })),
    getBalances: vi.fn(async () => balances),
    syncQuotes: vi.fn(async () => ({ fundId: 'fund-1', fetched: 1, stored: 1, errors: [] })),
    bookMark: vi.fn(async () => bookResult),
    now: () => new Date('2026-10-23T23:59:00Z'),
  }
})

describe('runKrakenCustodySync', () => {
  it('persists the observed balance and books a mark only after quantity matches', async () => {
    const db = seed()
    const result = await runKrakenCustodySync(db.admin, 'cx-1', deps)

    expect(db.tables.custody_balance_observations).toContainEqual(expect.objectContaining({
      fund_id: 'fund-1', position_id: 'pos-1', as_of_date: '2026-10-23',
      units: '2.000000005', source: 'kraken', raw_asset_code: 'BTC',
    }))
    expect(deps.bookMark).toHaveBeenCalledWith(
      db.admin, 'fund-1', 'user-1', 'btc-company', 'KC Bitcoin Fund I, L.P.', '2026-10-23',
    )
    expect(result.positions[0]).toMatchObject({ matched: true, observedUnits: '2.000000005', bookUnits: 2, booked: true })
    expect(JSON.stringify(result)).not.toContain('secret')
  })

  it('does not book when the provider and book quantities differ', async () => {
    balances.set('BTC', '2.25')
    const result = await runKrakenCustodySync(seed().admin, 'cx-1', deps)
    expect(deps.bookMark).not.toHaveBeenCalled()
    expect(result.positions[0]).toMatchObject({ matched: false, delta: 0.25, booked: false })
  })

  it('keeps auto-booking disabled positions observation-only', async () => {
    const result = await runKrakenCustodySync(seed({ position: { auto_book: false } }).admin, 'cx-1', deps)
    expect(deps.bookMark).not.toHaveBeenCalled()
    expect(result.positions[0]).toMatchObject({ matched: true, booked: false, reason: 'Automatic booking is disabled.' })
  })

  it('reports a missing Kraken asset without writing a zero observation', async () => {
    balances = new Map([['ETH', '1']])
    const db = seed()
    const result = await runKrakenCustodySync(db.admin, 'cx-1', deps)
    expect(db.tables.custody_balance_observations).toEqual([])
    expect(deps.bookMark).not.toHaveBeenCalled()
    expect(result.positions[0]).toMatchObject({ booked: false, error: expect.stringMatching(/BTC.*not returned/) })
  })

  it('surfaces a missing price or duplicate mark as a safe non-booking result', async () => {
    bookResult = { booked: false, reason: 'No BTC quote on or before 2026-10-23.' }
    const missing = await runKrakenCustodySync(seed().admin, 'cx-1', deps)
    expect(missing.positions[0]).toMatchObject({ matched: true, booked: false, reason: expect.stringMatching(/No BTC quote/) })

    bookResult = { booked: false, reason: 'A quoted mark is already booked for KC Bitcoin Fund I, L.P. on 2026-10-23.' }
    const duplicate = await runKrakenCustodySync(seed().admin, 'cx-1', deps)
    expect(duplicate.positions[0]).toMatchObject({ matched: true, booked: false, reason: expect.stringMatching(/already booked/) })
  })

  it('fails closed and records a redacted provider error', async () => {
    deps.getBalances = vi.fn(async () => { throw new Error('Kraken read failed for secret') })
    const db = seed()
    const result = await runKrakenCustodySync(db.admin, 'cx-1', deps)
    expect(result).toMatchObject({ connectionId: 'cx-1', error: 'Kraken balance request failed.' })
    expect(db.tables.custody_balance_observations).toEqual([])
    expect(db.tables.custody_connections[0].last_error).toBe('Kraken balance request failed.')
    expect(JSON.stringify(result)).not.toContain('secret')
  })
})

