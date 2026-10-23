import { createHash, createHmac } from 'node:crypto'

const BASE_URL = 'https://api.kraken.com'

export class KrakenApiError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message)
    this.name = 'KrakenApiError'
  }
}

export function signKrakenRequest(path: string, formBody: string, nonce: string, secretBase64: string): string {
  const bodyHash = createHash('sha256').update(nonce + formBody).digest()
  return createHmac('sha512', Buffer.from(secretBase64, 'base64'))
    .update(Buffer.concat([Buffer.from(path), bodyHash]))
    .digest('base64')
}

const ASSET_ALIASES: Record<string, string> = {
  XXBT: 'BTC', XBT: 'BTC', BTC: 'BTC', ZUSD: 'USD', USD: 'USD',
}

export function normalizeKrakenAsset(asset: string): string {
  const upper = asset.trim().toUpperCase()
  return ASSET_ALIASES[upper] ?? upper
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

interface KrakenClientOptions {
  apiKey?: string
  apiSecret?: string
  fetchImpl?: FetchLike
  nonce?: () => string
  timeoutMs?: number
}

export class KrakenClient {
  private readonly apiKey: string | null
  private readonly apiSecret: string | null
  private readonly fetchImpl: FetchLike
  private readonly nonce: () => string
  private readonly timeoutMs: number

  constructor(options: KrakenClientOptions = {}) {
    this.apiKey = options.apiKey?.trim() || null
    this.apiSecret = options.apiSecret?.trim() || null
    this.fetchImpl = options.fetchImpl ?? fetch
    this.nonce = options.nonce ?? (() => Date.now().toString())
    this.timeoutMs = options.timeoutMs ?? 10_000
  }

  async tickerLast(pair: string): Promise<number> {
    const requested = pair.trim().toUpperCase()
    if (!requested) throw new KrakenApiError('Kraken market is required')
    const payload = await this.request(`/0/public/Ticker?pair=${encodeURIComponent(requested)}`, { method: 'GET' })
    const markets = payload.result && typeof payload.result === 'object' ? Object.values(payload.result) : []
    if (markets.length !== 1) throw new KrakenApiError(`Kraken market ${requested} was not returned`)
    const raw = (markets[0] as any)?.c?.[0]
    const price = Number(raw)
    if (!Number.isFinite(price) || price <= 0) throw new KrakenApiError(`Kraken returned an invalid price for ${requested}`)
    return price
  }

  async balance(): Promise<Map<string, string>> {
    if (!this.apiKey || !this.apiSecret) throw new KrakenApiError('Kraken read-only credentials are required')
    const path = '/0/private/Balance'
    const nonce = this.nonce()
    const body = new URLSearchParams({ nonce }).toString()
    const signature = signKrakenRequest(path, body, nonce, this.apiSecret)
    const payload = await this.request(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'API-Key': this.apiKey,
        'API-Sign': signature,
      },
      body,
    })
    if (!payload.result || typeof payload.result !== 'object' || Array.isArray(payload.result)) {
      throw new KrakenApiError('Kraken returned an invalid balance payload')
    }
    const balances = new Map<string, string>()
    for (const [rawAsset, rawUnits] of Object.entries(payload.result)) {
      if (typeof rawUnits !== 'string' || !Number.isFinite(Number(rawUnits))) {
        throw new KrakenApiError(`Kraken returned an invalid balance for ${rawAsset}`)
      }
      balances.set(normalizeKrakenAsset(rawAsset), rawUnits)
    }
    return balances
  }

  private async request(path: string, init: RequestInit): Promise<any> {
    let res: Response
    try {
      res = await this.fetchImpl(`${BASE_URL}${path}`, {
        ...init,
        signal: init.signal ?? AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new KrakenApiError(error instanceof Error && error.name === 'TimeoutError'
        ? 'Kraken request timed out'
        : 'Could not reach Kraken')
    }
    if (!res.ok) throw new KrakenApiError(`Kraken HTTP ${res.status}`, res.status)
    let payload: any
    try {
      payload = await res.json()
    } catch {
      throw new KrakenApiError('Kraken returned invalid JSON', res.status)
    }
    const errors = Array.isArray(payload?.error) ? payload.error.filter((e: unknown) => typeof e === 'string' && e) : []
    if (errors.length > 0) throw new KrakenApiError(`Kraken: ${errors.join('; ')}`, res.status)
    return payload
  }
}

