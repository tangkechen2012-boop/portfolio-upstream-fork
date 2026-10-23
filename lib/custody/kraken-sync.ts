import type { SupabaseClient } from '@supabase/supabase-js'
import { buildSoiPositions, type SoiCompany } from '@/lib/accounting/soi'
import { KrakenClient } from '@/lib/kraken/client'
import { bookQuoteMark, type BookQuoteMarkResult } from '@/lib/portfolio/quote-marks'
import { syncFundQuotes, type SyncResult } from '@/lib/portfolio/quote-sync'
import {
  getCustodyCredentials,
  markCustodyConnectionError,
  markCustodyConnectionOk,
} from './credentials'
import { reconcileCustodyUnits } from './reconcile'
import type { CustodyCredentials, CustodyPositionRow } from './types'

export interface KrakenPositionSyncResult {
  positionId: string
  assetCode: string
  observedUnits: string | null
  bookUnits: number | null
  delta: number | null
  matched: boolean
  observationStored: boolean
  booked: boolean
  reason?: string
  error?: string
}

export interface KrakenCustodySyncResult {
  connectionId: string
  fundId: string | null
  asOfDate: string
  quoteSync: SyncResult | null
  positions: KrakenPositionSyncResult[]
  error?: string
}

export interface KrakenCustodySyncDependencies {
  getCredentials: (admin: SupabaseClient, connectionId: string) => Promise<CustodyCredentials | null>
  getBalances: (credentials: CustodyCredentials) => Promise<Map<string, string>>
  syncQuotes: (admin: SupabaseClient, fundId: string, asOfDate: string) => Promise<SyncResult>
  bookMark: (
    admin: SupabaseClient,
    fundId: string,
    userId: string,
    companyId: string,
    group: string,
    asOfDate: string,
  ) => Promise<BookQuoteMarkResult>
  now: () => Date
}

const defaults: KrakenCustodySyncDependencies = {
  getCredentials: getCustodyCredentials,
  getBalances: async credentials => new KrakenClient(credentials).balance(),
  syncQuotes: syncFundQuotes,
  bookMark: bookQuoteMark,
  now: () => new Date(),
}

function emptyPosition(position: CustodyPositionRow): KrakenPositionSyncResult {
  return {
    positionId: position.id,
    assetCode: position.asset_code,
    observedUnits: null,
    bookUnits: null,
    delta: null,
    matched: false,
    observationStored: false,
    booked: false,
  }
}

async function recordConnectionError(admin: SupabaseClient, connectionId: string, message: string) {
  await markCustodyConnectionError(admin, connectionId, message)
}

export async function runKrakenCustodySync(
  admin: SupabaseClient,
  connectionId: string,
  dependencies: KrakenCustodySyncDependencies = defaults,
): Promise<KrakenCustodySyncResult> {
  const asOfDate = dependencies.now().toISOString().slice(0, 10)
  const result: KrakenCustodySyncResult = {
    connectionId,
    fundId: null,
    asOfDate,
    quoteSync: null,
    positions: [],
  }

  const { data: rawConnection, error: connectionError } = await admin
    .from('custody_connections')
    .select('id, fund_id, provider, active, created_by')
    .eq('id', connectionId)
    .maybeSingle()
  const connection = rawConnection as any
  if (connectionError || !connection || connection.provider !== 'kraken' || !connection.active) {
    result.error = 'Active Kraken connection not found.'
    return result
  }
  result.fundId = connection.fund_id as string

  const credentials = await dependencies.getCredentials(admin, connectionId)
  if (!credentials) {
    result.error = 'Custody credentials are unavailable.'
    await recordConnectionError(admin, connectionId, result.error)
    return result
  }

  let balances: Map<string, string>
  try {
    balances = await dependencies.getBalances(credentials)
  } catch {
    result.error = 'Kraken balance request failed.'
    await recordConnectionError(admin, connectionId, result.error)
    return result
  }

  try {
    result.quoteSync = await dependencies.syncQuotes(admin, result.fundId, asOfDate)
  } catch {
    result.quoteSync = { fundId: result.fundId, fetched: 0, stored: 0, errors: ['Quote refresh failed.'] }
  }

  const { data: rawPositions, error: positionsError } = await admin
    .from('custody_positions')
    .select('*')
    .eq('connection_id', connectionId)
    .eq('fund_id', result.fundId)
    .eq('active', true)
  if (positionsError) {
    result.error = 'Custody position mappings could not be read.'
    await recordConnectionError(admin, connectionId, result.error)
    return result
  }
  const positions = (rawPositions ?? []) as unknown as CustodyPositionRow[]
  if (positions.length === 0) {
    await markCustodyConnectionOk(admin, connectionId)
    return result
  }

  const companyIds = Array.from(new Set(positions.map(position => position.company_id)))
  const vehicleIds = Array.from(new Set(positions.map(position => position.vehicle_id)))
  const [{ data: rawCompanies, error: companiesError }, { data: rawVehicles, error: vehiclesError }, { data: rawTransactions, error: transactionsError }] = await Promise.all([
    admin.from('companies').select('id, name, holding_type, status, industry, stage, portfolio_group').eq('fund_id', result.fundId).in('id', companyIds),
    admin.from('fund_vehicles').select('id, name').eq('fund_id', result.fundId).in('id', vehicleIds),
    admin.from('investment_transactions').select('*').eq('fund_id', result.fundId).in('company_id', companyIds),
  ])
  if (companiesError || vehiclesError || transactionsError) {
    result.error = 'Book positions could not be read.'
    await recordConnectionError(admin, connectionId, result.error)
    return result
  }

  const companies = (rawCompanies ?? []) as unknown as SoiCompany[]
  const companyById = new Map(companies.map(company => [company.id, company]))
  const vehicleById = new Map(((rawVehicles ?? []) as any[]).map(vehicle => [vehicle.id as string, vehicle.name as string]))
  const transactions = ((rawTransactions ?? []) as any[]).filter(transaction =>
    !transaction.transaction_date || transaction.transaction_date <= asOfDate)
  const quoteRefreshFailed = (result.quoteSync?.errors.length ?? 0) > 0

  for (const position of positions) {
    const item = emptyPosition(position)
    result.positions.push(item)
    const observedUnits = balances.get(position.asset_code.trim().toUpperCase())
    if (observedUnits == null) {
      item.error = `${position.asset_code} was not returned by Kraken.`
      continue
    }

    const company = companyById.get(position.company_id)
    const vehicleName = vehicleById.get(position.vehicle_id)
    if (!company || !vehicleName) {
      item.error = 'The mapped holding or entity no longer exists.'
      continue
    }

    const bookUnits = buildSoiPositions(
      transactions.filter(transaction => transaction.company_id === position.company_id),
      [company],
      vehicleName,
      new Date(`${asOfDate}T23:59:59.999Z`),
    )[0]?.shares ?? 0

    let reconciliation
    try {
      reconciliation = reconcileCustodyUnits(bookUnits, observedUnits, Number(position.tolerance))
    } catch {
      item.error = 'The custody quantity could not be reconciled.'
      continue
    }
    Object.assign(item, reconciliation)

    const { error: observationError } = await admin
      .from('custody_balance_observations')
      .upsert({
        fund_id: result.fundId,
        position_id: position.id,
        as_of_date: asOfDate,
        units: observedUnits,
        source: 'kraken',
        raw_asset_code: position.asset_code,
        fetched_at: dependencies.now().toISOString(),
      } as any, { onConflict: 'position_id,as_of_date' })
    if (observationError) {
      item.error = 'The observed balance could not be stored.'
      continue
    }
    item.observationStored = true

    if (!position.auto_book) {
      item.reason = 'Automatic booking is disabled.'
      continue
    }
    if (!item.matched) {
      item.reason = 'Custody and book quantities do not match.'
      continue
    }
    if (quoteRefreshFailed) {
      item.reason = 'Quote refresh failed; no mark was booked.'
      continue
    }
    if (!connection.created_by) {
      item.reason = 'The connection has no authorizing administrator; no mark was booked.'
      continue
    }

    try {
      const booking = await dependencies.bookMark(
        admin,
        result.fundId,
        connection.created_by as string,
        position.company_id,
        vehicleName,
        asOfDate,
      )
      item.booked = booking.booked
      if (!booking.booked) item.reason = booking.reason
    } catch {
      item.error = 'The automatic mark could not be booked.'
    }
  }

  if (quoteRefreshFailed) {
    result.error = 'Quote refresh failed.'
  } else {
    const failedPositions = result.positions.filter(position => !!position.error).length
    if (failedPositions > 0) {
      result.error = `${failedPositions} custody position${failedPositions === 1 ? '' : 's'} failed.`
    }
  }
  if (result.error) await recordConnectionError(admin, connectionId, result.error)
  else await markCustodyConnectionOk(admin, connectionId)
  return result
}
