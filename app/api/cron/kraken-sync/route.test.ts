import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({ from: vi.fn(), run: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: h.from }) }))
vi.mock('@/lib/custody/kraken-sync', () => ({ runKrakenCustodySync: h.run }))

import { GET } from './route'

const req = (auth?: string) => new NextRequest('https://app.example.com/api/cron/kraken-sync', {
  headers: auth ? { authorization: auth } : {},
})
const saved = process.env.CRON_SECRET

beforeEach(() => {
  vi.clearAllMocks()
  process.env.CRON_SECRET = 'secret'
  h.from.mockReturnValue({
    select: () => ({ eq: async () => ({ data: [{ id: 'cx-1' }, { id: 'cx-2' }], error: null }) }),
  })
})

afterEach(() => {
  if (saved === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = saved
})

describe('Kraken custody cron', () => {
  it('fails closed without the configured bearer token', async () => {
    expect((await GET(req())).status).toBe(401)
    delete process.env.CRON_SECRET
    expect((await GET(req('Bearer undefined'))).status).toBe(500)
  })

  it('isolates one failed connection and continues the rest', async () => {
    h.run.mockRejectedValueOnce(new Error('first failed')).mockResolvedValueOnce({ connectionId: 'cx-2', error: undefined })
    const res = await GET(req('Bearer secret'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: false, total: 2, succeeded: 1, failed: 1 })
    expect(h.run).toHaveBeenCalledTimes(2)
  })
})

