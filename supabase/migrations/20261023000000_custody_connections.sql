-- Read-only exchange custody observations. These rows are deliberately separate from
-- crypto_wallets: an exchange account is authenticated custody, not a public address.

create table public.custody_connections (
  id                   uuid primary key default gen_random_uuid(),
  fund_id              uuid not null references public.funds(id) on delete cascade,
  provider             text not null check (provider in ('kraken')),
  label                text not null default 'Kraken',
  api_key_encrypted    text,
  api_secret_encrypted text,
  active               boolean not null default true,
  last_synced_at       timestamptz,
  last_error           text,
  created_by           uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index custody_connections_fund_idx
  on public.custody_connections (fund_id, active);

create table public.custody_positions (
  id             uuid primary key default gen_random_uuid(),
  fund_id        uuid not null references public.funds(id) on delete cascade,
  connection_id  uuid not null references public.custody_connections(id) on delete cascade,
  company_id     uuid not null references public.companies(id) on delete cascade,
  vehicle_id     uuid not null references public.fund_vehicles(id) on delete cascade,
  price_feed_id  uuid references public.price_feeds(id) on delete set null,
  asset_code     text not null,
  auto_book      boolean not null default false,
  tolerance      numeric not null default 0.00000001 check (tolerance >= 0),
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (connection_id, company_id, vehicle_id)
);

create index custody_positions_fund_idx
  on public.custody_positions (fund_id, connection_id, active);

create table public.custody_balance_observations (
  id             uuid primary key default gen_random_uuid(),
  fund_id        uuid not null references public.funds(id) on delete cascade,
  position_id    uuid not null references public.custody_positions(id) on delete cascade,
  as_of_date     date not null,
  units          numeric not null check (units >= 0),
  source         text not null default 'kraken' check (source in ('kraken')),
  raw_asset_code text,
  fetched_at     timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  unique (position_id, as_of_date)
);

create index custody_balance_observations_position_idx
  on public.custody_balance_observations (position_id, as_of_date desc);
create index custody_balance_observations_fund_idx
  on public.custody_balance_observations (fund_id, as_of_date desc);

comment on table public.custody_connections is
  'Encrypted read-only exchange connections. Never exposed through the Data API.';
comment on table public.custody_balance_observations is
  'Provider-reported units; evidence for reconciliation, never a silent replacement for book quantity.';

alter table public.custody_connections enable row level security;
alter table public.custody_positions enable row level security;
alter table public.custody_balance_observations enable row level security;

revoke all on public.custody_connections from anon, authenticated;
revoke all on public.custody_positions from anon, authenticated;
revoke all on public.custody_balance_observations from anon, authenticated;

grant select, insert, update, delete on public.custody_connections to service_role;
grant select, insert, update, delete on public.custody_positions to service_role;
grant select, insert, update, delete on public.custody_balance_observations to service_role;
