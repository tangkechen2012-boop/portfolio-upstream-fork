import { KrakenClient, normalizeKrakenAsset } from '@/lib/kraken/client'
import type { QuoteProvider, QuoteResult } from './types'

type TickerClient = Pick<KrakenClient, 'tickerLast'>

export function createKrakenProvider(
  client: TickerClient = new KrakenClient(),
  now: () => Date = () => new Date(),
): QuoteProvider {
  return {
    name: 'kraken',
    async fetch(feeds) {
      const eligible = feeds.filter(f => f.kind === 'digital_asset' && f.quoteCurrency.toUpperCase() === 'USD')
      const out = new Map<string, QuoteResult>()
      const asOfDate = now().toISOString().slice(0, 10)
      await Promise.all(eligible.map(async feed => {
        const asset = normalizeKrakenAsset(feed.symbol)
        const price = await client.tickerLast(`${asset}USD`)
        out.set(feed.id, { price, asOfDate, basis: 'intraday' })
      }))
      return out
    },
  }
}

export const krakenProvider = createKrakenProvider()

