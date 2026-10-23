import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  getUser: vi.fn(),
  from: vi.fn(),
  balance: vi.fn(),
  saveCredentials: vi.fn(),
  runSync: vi.fn(),
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: h.getUser } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: h.from }) }))
vi.mock('@/lib/kraken/client', () => ({
  KrakenClient: class { balance = h.balance },
  normalizeKrakenAsset: (asset: string) => asset.trim().toUpperCase(),
}))
vi.mock('@/lib/custody/credentials', () => ({ saveCustodyCredentials: h.saveCredentials }))
vi.mock('@/lib/custody/kraken-sync', () => ({ runKrakenCustodySync: h.runSync }))

import { DELETE, GET, POST } from './route'

type Row = Record<string, any>
let membership: Row | null
let connections: Row[]
let positions: Row[]
let writes: Array<{ table: string; op: string; value?: any }>

function query(table: string): any {
  let op = 'select'
  let value: any
  const filters: Row = {}
  const result = () => {
    if (table === 'fund_members') return { data: membership, error: null }
    if (table === 'custody_connections') {
      const rows = connections.filter(row => Object.entries(filters).every(([key, val]) => row[key] === val))
      if (op === 'insert') {
        const row = { id: 'cx-new', ...value }
        connections.push(row)
        writes.push({ table, op, value: row })
        return { data: row, error: null }
      }
      if (op === 'delete') {
        connections = connections.filter(row => !rows.includes(row))
        writes.push({ table, op })
        return { data: null, error: null }
      }
      return { data: rows, error: null }
    }
    if (table === 'custody_positions') {
      const rows = positions.filter(row => Object.entries(filters).every(([key, val]) => row[key] === val))
      if (op === 'insert') {
        const list = Array.isArray(value) ? value : [value]
        positions.push(...list)
        writes.push({ table, op, value: list })
        return { data: null, error: null }
      }
      return { data: rows, error: null }
    }
    return { data: [], error: null }
  }
  const q: any = {
    select: () => q,
    insert: (next: any) => { op = 'insert'; value = next; return q },
    delete: () => { op = 'delete'; return q },
    eq: (key: string, val: unknown) => { filters[key] = val; return q },
    maybeSingle: async () => {
      const r = result()
      return { ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data }
    },
    single: async () => {
      const r = result()
      return { ...r, data: Array.isArray(r.data) ? r.data[0] ?? null : r.data }
    },
    then: (resolve: any, reject: any) => Promise.resolve(result()).then(resolve, reject),
  }
  return q
}

const request = (method: string, body?: unknown, search = '') => new NextRequest(
  `https://app.example.com/api/settings/kraken${search}`,
  { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { 'content-type': 'application/json' } },
)

beforeEach(() => {
  vi.clearAllMocks()
  membership = { fund_id: 'fund-1', role: 'admin' }
  connections = [{
    id: 'cx-1', fund_id: 'fund-1', provider: 'kraken', label: 'Main', active: true,
    api_key_encrypted: 'cipher-key', api_secret_encrypted: 'cipher-secret', last_synced_at: null,
    last_error: null, created_at: '2026-10-23T00:00:00Z', updated_at: '2026-10-23T00:00:00Z',
  }]
  positions = [{
    id: 'pos-1', fund_id: 'fund-1', connection_id: 'cx-1', company_id: 'co-1', vehicle_id: 'v-1',
    price_feed_id: 'feed-1', asset_code: 'BTC', auto_book: true, tolerance: '0.00000001', active: true,
  }]
  writes = []
  h.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  h.from.mockImplementation(query)
  h.balance.mockResolvedValue(new Map([['BTC', '1']]))
  h.saveCredentials.mockResolvedValue(undefined)
  h.runSync.mockResolvedValue({ connectionId: 'cx-1', fundId: 'fund-1', positions: [], asOfDate: '2026-10-23', quoteSync: null })
})

describe('/api/settings/kraken', () => {
  it('requires an authenticated fund admin', async () => {
    h.getUser.mockResolvedValueOnce({ data: { user: null } })
    expect((await GET())!.status).toBe(401)
    membership = { fund_id: 'fund-1', role: 'member' }
    expect((await GET())!.status).toBe(403)
  })

  it('returns status and mappings without either encrypted credential', async () => {
    const body = await (await GET())!.json()
    expect(body.connections[0]!).toMatchObject({ id: 'cx-1', connected: true, label: 'Main' })
    expect(body.connections[0]!.positions[0]!).toMatchObject({ asset_code: 'BTC', auto_book: true })
    expect(JSON.stringify(body)).not.toContain('cipher-key')
    expect(JSON.stringify(body)).not.toContain('cipher-secret')
    expect(body.connections[0]!).not.toHaveProperty('api_key_encrypted')
  })

  it('validates credentials before storing an admin-created connection and mapping', async () => {
    const res = (await POST(request('POST', {
      action: 'connect', api_key: 'key', api_secret: 'secret', label: 'Treasury',
      positions: [{ company_id: 'co-1', vehicle_id: 'v-1', price_feed_id: 'feed-1', asset_code: 'BTC', auto_book: true }],
    })))!
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(h.balance).toHaveBeenCalledOnce()
    expect(h.saveCredentials).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ connectionId: 'cx-new', fundId: 'fund-1', apiKey: 'key', apiSecret: 'secret' }))
    expect(writes.find(write => write.table === 'custody_positions')?.value[0]).toMatchObject({ connection_id: 'cx-new', asset_code: 'BTC', auto_book: true })
    expect(JSON.stringify(body)).not.toContain('secret')
  })

  it('rejects incomplete connection input before calling Kraken', async () => {
    const res = (await POST(request('POST', { action: 'connect', api_key: 'key', positions: [] })))!
    expect(res.status).toBe(400)
    expect(h.balance).not.toHaveBeenCalled()
  })

  it('runs only a connection owned by the admin fund', async () => {
    const res = (await POST(request('POST', { action: 'run', connection_id: 'cx-1' })))!
    expect(res.status).toBe(200)
    expect(h.runSync).toHaveBeenCalledWith(expect.anything(), 'cx-1')
  })

  it('deletes only a connection owned by the admin fund', async () => {
    const res = (await DELETE(request('DELETE', undefined, '?connection_id=cx-1')))!
    expect(res.status).toBe(200)
    expect(connections).toHaveLength(0)
  })
})

