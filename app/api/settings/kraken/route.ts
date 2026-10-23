import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { KrakenClient, normalizeKrakenAsset } from '@/lib/kraken/client'
import { saveCustodyCredentials } from '@/lib/custody/credentials'
import { runKrakenCustodySync } from '@/lib/custody/kraken-sync'

async function ensureAdmin() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }

  const admin = createAdminClient()
  const { data: membership } = await admin
    .from('fund_members')
    .select('fund_id, role')
    .eq('user_id', user.id)
    .maybeSingle()
  if (!membership || (membership as any).role !== 'admin') {
    return { error: NextResponse.json({ error: 'Only a fund admin can manage custody connections.' }, { status: 403 }) }
  }
  return { admin, fundId: (membership as any).fund_id as string, userId: user.id }
}

export async function GET() {
  const guard = await ensureAdmin()
  if ('error' in guard) return guard.error
  const { admin, fundId } = guard
  const db = admin as any

  const [{ data: connections, error: connectionError }, { data: positions, error: positionError }] = await Promise.all([
    db.from('custody_connections')
      .select('id, provider, label, active, last_synced_at, last_error, created_at, updated_at')
      .eq('fund_id', fundId),
    db.from('custody_positions')
      .select('id, connection_id, company_id, vehicle_id, price_feed_id, asset_code, auto_book, tolerance, active')
      .eq('fund_id', fundId),
  ])
  if (connectionError || positionError) {
    return NextResponse.json({ error: 'Could not load Kraken settings.' }, { status: 500 })
  }

  const mappings = (positions ?? []) as any[]
  return NextResponse.json({
    connections: ((connections ?? []) as any[]).map(connection => ({
      id: connection.id,
      provider: connection.provider,
      label: connection.label,
      active: connection.active,
      // Creation is atomic at the route boundary: a row whose encrypted credentials fail to save
      // is deleted. Do not read secret columns merely to derive this status bit.
      connected: true,
      last_synced_at: connection.last_synced_at,
      last_error: connection.last_error,
      created_at: connection.created_at,
      updated_at: connection.updated_at,
      positions: mappings
        .filter(position => position.connection_id === connection.id)
        .map(({ connection_id: _connectionId, ...position }) => position),
    })),
  })
}

interface ParsedMapping {
  company_id: string
  vehicle_id: string
  price_feed_id: string
  asset_code: string
  auto_book: boolean
  tolerance: number
  active: boolean
}

function parseMapping(raw: any): ParsedMapping | null {
  const companyId = typeof raw?.company_id === 'string' ? raw.company_id.trim() : ''
  const vehicleId = typeof raw?.vehicle_id === 'string' ? raw.vehicle_id.trim() : ''
  const priceFeedId = typeof raw?.price_feed_id === 'string' ? raw.price_feed_id.trim() : ''
  const assetCode = typeof raw?.asset_code === 'string' ? normalizeKrakenAsset(raw.asset_code) : ''
  const tolerance = raw?.tolerance == null ? 0.00000001 : Number(raw.tolerance)
  if (!companyId || !vehicleId || !priceFeedId || !assetCode || !Number.isFinite(tolerance) || tolerance < 0) return null
  return {
    company_id: companyId,
    vehicle_id: vehicleId,
    price_feed_id: priceFeedId,
    asset_code: assetCode,
    auto_book: raw?.auto_book === true,
    tolerance,
    active: true,
  }
}

export async function POST(req: NextRequest) {
  const guard = await ensureAdmin()
  if ('error' in guard) return guard.error
  const { admin, fundId, userId } = guard
  const db = admin as any
  const body = await req.json().catch(() => ({}))

  if (body.action === 'run') {
    const connectionId = typeof body.connection_id === 'string' ? body.connection_id : ''
    if (!connectionId) return NextResponse.json({ error: 'connection_id is required' }, { status: 400 })
    const { data: connection } = await db.from('custody_connections').select('id')
      .eq('id', connectionId).eq('fund_id', fundId).maybeSingle()
    if (!connection) return NextResponse.json({ error: 'Connection not found' }, { status: 404 })
    return NextResponse.json(await runKrakenCustodySync(admin, connectionId))
  }

  if (body.action !== 'connect') {
    return NextResponse.json({ error: 'action must be connect or run' }, { status: 400 })
  }
  const apiKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
  const apiSecret = typeof body.api_secret === 'string' ? body.api_secret.trim() : ''
  const mappings: Array<ParsedMapping | null> = Array.isArray(body.positions) ? body.positions.map(parseMapping) : []
  if (!apiKey || !apiSecret || mappings.length === 0 || mappings.some(mapping => !mapping)) {
    return NextResponse.json({ error: 'api_key, api_secret, and at least one valid position mapping are required' }, { status: 400 })
  }

  try {
    await new KrakenClient({ apiKey, apiSecret }).balance()
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not verify Kraken credentials' }, { status: 400 })
  }

  const { data: connection, error: insertError } = await db.from('custody_connections').insert({
    fund_id: fundId,
    provider: 'kraken',
    label: typeof body.label === 'string' && body.label.trim() ? body.label.trim() : 'Kraken',
    active: true,
    created_by: userId,
  } as any).select('id').single()
  if (insertError || !connection) return NextResponse.json({ error: 'Could not create Kraken connection.' }, { status: 500 })
  const connectionId = (connection as any).id as string

  try {
    await saveCustodyCredentials(admin, { connectionId, fundId, apiKey, apiSecret })
    const { error: positionError } = await db.from('custody_positions').insert(mappings.map((mapping: ParsedMapping | null) => ({
      ...mapping!, fund_id: fundId, connection_id: connectionId,
    })) as any)
    if (positionError) throw new Error('Could not save custody position mappings.')
  } catch {
    await db.from('custody_connections').delete().eq('id', connectionId).eq('fund_id', fundId)
    return NextResponse.json({ error: 'Could not securely save Kraken settings.' }, { status: 500 })
  }

  return NextResponse.json({ connected: true, connection_id: connectionId, positions: mappings.length })
}

export async function DELETE(req: NextRequest) {
  const guard = await ensureAdmin()
  if ('error' in guard) return guard.error
  const connectionId = req.nextUrl.searchParams.get('connection_id')?.trim() ?? ''
  if (!connectionId) return NextResponse.json({ error: 'connection_id is required' }, { status: 400 })

  const { error } = await (guard.admin as any).from('custody_connections').delete()
    .eq('id', connectionId).eq('fund_id', guard.fundId)
  if (error) return NextResponse.json({ error: 'Could not delete Kraken connection.' }, { status: 500 })
  return NextResponse.json({ connected: false })
}
