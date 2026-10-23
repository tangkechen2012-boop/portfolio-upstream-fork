import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decrypt } from '@/lib/crypto'
import { getCustodyCredentials, saveCustodyCredentials } from './credentials'

const kek = '11'.repeat(32)
const existingDek = '22'.repeat(32)

type Row = Record<string, any>

function memoryAdmin(initial: { wrappedDek?: string | null; connection?: Row | null } = {}) {
  let wrappedDek = initial.wrappedDek ?? null
  let connection = initial.connection ?? null
  const writes: Array<{ table: string; value: Row; filters: Row }> = []

  function from(table: string) {
    const filters: Row = {}
    let value: Row = {}
    let op: 'select' | 'update' = 'select'
    const chain: any = {
      select: () => chain,
      update: (next: Row) => {
        op = 'update'
        value = next
        return chain
      },
      eq: (column: string, next: unknown) => {
        filters[column] = next
        return chain
      },
      maybeSingle: async () => {
        if (table === 'fund_settings') {
          return { data: wrappedDek ? { encryption_key_encrypted: wrappedDek } : null, error: null }
        }
        if (table === 'custody_connections') return { data: connection, error: null }
        return { data: null, error: null }
      },
      then: (resolve: (result: unknown) => unknown, reject?: (error: unknown) => unknown) => {
        if (op === 'update') {
          writes.push({ table, value, filters: { ...filters } })
          if (table === 'fund_settings') wrappedDek = value.encryption_key_encrypted
          if (table === 'custody_connections') connection = { ...connection, ...value }
        }
        return Promise.resolve({ data: null, error: null }).then(resolve, reject)
      },
    }
    return chain
  }

  return { admin: { from } as any, writes, get connection() { return connection }, get wrappedDek() { return wrappedDek } }
}

beforeEach(() => {
  process.env.ENCRYPTION_KEY = kek
})

afterEach(() => {
  delete process.env.ENCRYPTION_KEY
})

describe('custody credentials', () => {
  it('encrypts both Kraken secrets with the existing fund DEK', async () => {
    const { encrypt } = await import('@/lib/crypto')
    const db = memoryAdmin({ wrappedDek: encrypt(existingDek, kek) })

    await saveCustodyCredentials(db.admin, {
      connectionId: 'connection-1',
      fundId: 'fund-1',
      apiKey: 'public-key',
      apiSecret: 'private-secret',
    })

    const write = db.writes.find(item => item.table === 'custody_connections')!
    expect(write.filters).toEqual({ id: 'connection-1', fund_id: 'fund-1' })
    expect(write.value.api_key_encrypted).not.toContain('public-key')
    expect(write.value.api_secret_encrypted).not.toContain('private-secret')
    expect(decrypt(write.value.api_key_encrypted, existingDek)).toBe('public-key')
    expect(decrypt(write.value.api_secret_encrypted, existingDek)).toBe('private-secret')
  })

  it('mints and wraps a fund DEK when the fund has none', async () => {
    const db = memoryAdmin()

    await saveCustodyCredentials(db.admin, {
      connectionId: 'connection-1',
      fundId: 'fund-1',
      apiKey: 'public-key',
      apiSecret: 'private-secret',
    })

    const dekWrite = db.writes.find(item => item.table === 'fund_settings')!
    const mintedDek = decrypt(dekWrite.value.encryption_key_encrypted, kek)
    expect(mintedDek).toMatch(/^[0-9a-f]{64}$/)
    const connectionWrite = db.writes.find(item => item.table === 'custody_connections')!
    expect(decrypt(connectionWrite.value.api_key_encrypted, mintedDek)).toBe('public-key')
    expect(decrypt(connectionWrite.value.api_secret_encrypted, mintedDek)).toBe('private-secret')
  })

  it('loads and decrypts a connection without returning ciphertext', async () => {
    const { encrypt } = await import('@/lib/crypto')
    const db = memoryAdmin({
      wrappedDek: encrypt(existingDek, kek),
      connection: {
        id: 'connection-1',
        fund_id: 'fund-1',
        api_key_encrypted: encrypt('public-key', existingDek),
        api_secret_encrypted: encrypt('private-secret', existingDek),
      },
    })

    await expect(getCustodyCredentials(db.admin, 'connection-1')).resolves.toEqual({
      apiKey: 'public-key',
      apiSecret: 'private-secret',
    })
  })

  it('fails closed when ciphertext cannot be decrypted', async () => {
    const { encrypt } = await import('@/lib/crypto')
    const db = memoryAdmin({
      wrappedDek: encrypt(existingDek, kek),
      connection: {
        id: 'connection-1',
        fund_id: 'fund-1',
        api_key_encrypted: 'not-ciphertext',
        api_secret_encrypted: 'not-ciphertext',
      },
    })

    await expect(getCustodyCredentials(db.admin, 'connection-1')).resolves.toBeNull()
  })
})
