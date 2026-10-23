import { describe, expect, it, vi } from 'vitest'
import type { PriceFeed } from '../quotes'
import { createKrakenProvider } from './kraken'
import { PROVIDER_NAMES, providerFor } from './index'

const feed = (overrides: Partial<PriceFeed> = {}): PriceFeed => ({
  id: 'btc-feed', companyId: 'btc', kind: 'digital_asset', symbol: 'BTC',
  quoteCurrency: 'USD', quoteScale: 1, activeFrom: '2026-01-01',
  activeUntil: null, restrictionUntil: null, restrictionDiscount: null,
  ...overrides,
})

describe('Kraken quote provider', () => {
  it('returns an intraday observation dated by UTC', async () => {
    const tickerLast = vi.fn(async () => 81360.9)
    const provider = createKrakenProvider({ tickerLast } as any, () => new Date('2026-10-24T00:01:00-04:00'))
    await expect(provider.fetch([feed()], { fundId: 'f' })).resolves.toEqual(new Map([
      ['btc-feed', { price: 81360.9, asOfDate: '2026-10-24', basis: 'intraday' }],
    ]))
    expect(tickerLast).toHaveBeenCalledWith('BTCUSD')
  })

  it('omits listed equities and non-USD feeds rather than guessing a market', async () => {
    const tickerLast = vi.fn(async () => 1)
    const provider = createKrakenProvider({ tickerLast } as any)
    const got = await provider.fetch([
      feed({ id: 'listed', kind: 'listed_equity' }),
      feed({ id: 'eur', quoteCurrency: 'EUR' }),
    ], { fundId: 'f' })
    expect(got.size).toBe(0)
    expect(tickerLast).not.toHaveBeenCalled()
  })

  it('is registered under the stored provider name', () => {
    expect(PROVIDER_NAMES).toContain('kraken')
    expect(providerFor('kraken').name).toBe('kraken')
  })
})

