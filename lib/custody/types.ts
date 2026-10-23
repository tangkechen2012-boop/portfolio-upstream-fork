export type CustodyProvider = 'kraken'

export interface CustodyConnectionRow {
  id: string
  fund_id: string
  provider: CustodyProvider
  label: string
  api_key_encrypted: string | null
  api_secret_encrypted: string | null
  active: boolean
  last_synced_at: string | null
  last_error: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

export interface CustodyPositionRow {
  id: string
  fund_id: string
  connection_id: string
  company_id: string
  vehicle_id: string
  price_feed_id: string | null
  asset_code: string
  auto_book: boolean
  tolerance: number | string
  active: boolean
  created_at: string
  updated_at: string
}

export interface CustodyBalanceObservationRow {
  id: string
  fund_id: string
  position_id: string
  as_of_date: string
  units: number | string
  source: CustodyProvider
  raw_asset_code: string | null
  fetched_at: string
  created_at: string
}

export interface CustodyCredentials {
  apiKey: string
  apiSecret: string
}

