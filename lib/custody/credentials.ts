import { randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, encrypt } from '@/lib/crypto'
import type { CustodyCredentials } from './types'

async function getOrCreateFundDek(admin: SupabaseClient, fundId: string): Promise<string> {
  const kek = process.env.ENCRYPTION_KEY
  if (!kek) throw new Error('ENCRYPTION_KEY is not configured')

  const { data, error } = await admin
    .from('fund_settings')
    .select('encryption_key_encrypted')
    .eq('fund_id', fundId)
    .maybeSingle()
  if (error) throw new Error(`Failed to load fund encryption key: ${error.message}`)

  const wrapped = (data as any)?.encryption_key_encrypted as string | null | undefined
  if (wrapped) return decrypt(wrapped, kek)

  const dek = randomBytes(32).toString('hex')
  const { error: updateError } = await admin
    .from('fund_settings')
    .update({ encryption_key_encrypted: encrypt(dek, kek) } as any)
    .eq('fund_id', fundId)
  if (updateError) throw new Error(`Failed to store fund encryption key: ${updateError.message}`)
  return dek
}

async function getFundDek(admin: SupabaseClient, fundId: string): Promise<string | null> {
  const kek = process.env.ENCRYPTION_KEY
  if (!kek) return null
  const { data, error } = await admin
    .from('fund_settings')
    .select('encryption_key_encrypted')
    .eq('fund_id', fundId)
    .maybeSingle()
  if (error) return null
  const wrapped = (data as any)?.encryption_key_encrypted as string | null | undefined
  if (!wrapped) return null
  try {
    return decrypt(wrapped, kek)
  } catch {
    return null
  }
}

export async function saveCustodyCredentials(
  admin: SupabaseClient,
  params: CustodyCredentials & { connectionId: string; fundId: string },
): Promise<void> {
  const dek = await getOrCreateFundDek(admin, params.fundId)
  const { error } = await admin
    .from('custody_connections')
    .update({
      api_key_encrypted: encrypt(params.apiKey, dek),
      api_secret_encrypted: encrypt(params.apiSecret, dek),
      last_error: null,
      updated_at: new Date().toISOString(),
    } as any)
    .eq('id', params.connectionId)
    .eq('fund_id', params.fundId)
  if (error) throw new Error(`Failed to save custody credentials: ${error.message}`)
}

export async function getCustodyCredentials(
  admin: SupabaseClient,
  connectionId: string,
): Promise<CustodyCredentials | null> {
  const { data, error } = await admin
    .from('custody_connections')
    .select('fund_id, api_key_encrypted, api_secret_encrypted')
    .eq('id', connectionId)
    .maybeSingle()
  if (error || !data) return null

  const row = data as any
  if (!row.api_key_encrypted || !row.api_secret_encrypted) return null
  const dek = await getFundDek(admin, row.fund_id as string)
  if (!dek) return null

  try {
    return {
      apiKey: decrypt(row.api_key_encrypted as string, dek),
      apiSecret: decrypt(row.api_secret_encrypted as string, dek),
    }
  } catch {
    return null
  }
}

export async function markCustodyConnectionError(
  admin: SupabaseClient,
  connectionId: string,
  message: string,
): Promise<void> {
  await admin
    .from('custody_connections')
    .update({ last_error: message.slice(0, 500), updated_at: new Date().toISOString() } as any)
    .eq('id', connectionId)
}

export async function markCustodyConnectionOk(
  admin: SupabaseClient,
  connectionId: string,
): Promise<void> {
  const now = new Date().toISOString()
  await admin
    .from('custody_connections')
    .update({ last_error: null, last_synced_at: now, updated_at: now } as any)
    .eq('id', connectionId)
}
