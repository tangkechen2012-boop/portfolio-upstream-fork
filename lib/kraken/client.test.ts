import { describe, expect, it, vi } from 'vitest'
import { KrakenApiError, KrakenClient, normalizeKrakenAsset, signKrakenRequest } from './client'

const response = (body: unknown, ok = true, status = 200) =>
  Promise.resolve({ ok, status, json: async () => body } as Response)

describe('Kraken request signing', () => {
  it('signs the exact path and nonce-prefixed form body Kraken authenticates', () => {
    expect(signKrakenRequest('/0/private/Balance', 'nonce=12345', '12345', 'c2VjcmV0')).toBe(
      'w8fTN+68gkCTfY6crcOKCbElAZsK5u7HJJ5Xw6OsMSyOO+6tW+gjN1Ed0TvVCKejc1Mspt1VNZnnrPo/szoNYw=='
    )
  })
})

describe('Kraken asset names', () => {
  it.each([
    ['XXBT', 'BTC'], ['XBT', 'BTC'], ['BTC', 'BTC'], ['ZUSD', 'USD'], ['USD', 'USD'], ['BABY', 'BABY'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeKrakenAsset(input)).toBe(expected)
  })
})

describe('KrakenClient', () => {
  it('reads the last trade from a ticker response whose result key differs from the request', async () => {
    const fetchImpl = vi.fn(() => response({ error: [], result: { XXBTZUSD: { c: ['81360.90000', '0.01'] } } }))
    const client = new KrakenClient({ fetchImpl })
    await expect(client.tickerLast('BTCUSD')).resolves.toBe(81360.9)
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.kraken.com/0/public/Ticker?pair=BTCUSD',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('authenticates Balance and returns normalized decimal strings', async () => {
    const fetchImpl = vi.fn(() => response({ error: [], result: { XXBT: '0.1922442000', ZUSD: '0.0029', BABY: '27.27993' } }))
    const client = new KrakenClient({
      apiKey: 'key', apiSecret: 'c2VjcmV0', fetchImpl, nonce: () => '12345',
    })
    await expect(client.balance()).resolves.toEqual(new Map([
      ['BTC', '0.1922442000'], ['USD', '0.0029'], ['BABY', '27.27993'],
    ]))
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.kraken.com/0/private/Balance',
      expect.objectContaining({
        method: 'POST', body: 'nonce=12345',
        headers: expect.objectContaining({ 'API-Key': 'key', 'API-Sign': expect.any(String) }),
      }),
    )
  })

  it('refuses a private call without both read-only credentials', async () => {
    await expect(new KrakenClient({ apiKey: 'key' }).balance()).rejects.toThrow(/credentials/i)
  })

  it('surfaces Kraken error arrays and never treats them as empty data', async () => {
    const client = new KrakenClient({ fetchImpl: () => response({ error: ['EAPI:Invalid key'], result: {} }) })
    await expect(client.tickerLast('BTCUSD')).rejects.toEqual(expect.objectContaining({
      name: 'KrakenApiError', message: 'Kraken: EAPI:Invalid key',
    }))
  })

  it.each([
    [{ error: [], result: {} }, /market/i],
    [{ error: [], result: { XXBTZUSD: { c: ['not-a-price'] } } }, /price/i],
  ])('fails closed for a malformed ticker payload', async (payload, message) => {
    const client = new KrakenClient({ fetchImpl: () => response(payload) })
    await expect(client.tickerLast('BTCUSD')).rejects.toThrow(message)
  })

  it('uses a typed error for an HTTP failure without echoing a response body', async () => {
    const client = new KrakenClient({ fetchImpl: () => response({ secret: 'do not echo' }, false, 503) })
    await expect(client.tickerLast('BTCUSD')).rejects.toEqual(expect.objectContaining<KrakenApiError>({
      name: 'KrakenApiError', status: 503, message: 'Kraken HTTP 503',
    }))
  })
})

