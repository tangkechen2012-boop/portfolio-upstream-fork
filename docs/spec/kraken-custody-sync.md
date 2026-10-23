# Kraken custody sync runbook

## Security boundary

- Create a dedicated Kraken API key with **Query Funds** only. Do not grant trading, deposit,
  withdrawal, export, or account-management permissions.
- The application encrypts both Kraken values with the fund data-encryption key. The fund key is
  wrapped by `ENCRYPTION_KEY`; neither ciphertext is returned by the settings API.
- `custody_connections`, `custody_positions`, and `custody_balance_observations` are service-role
  only. Browser Data API roles have no privileges on them.
- A Kraken balance is evidence for reconciliation. It never silently replaces book quantity.
  Automatic marking runs only when observed and book quantities match within the configured
  tolerance.

## Deployment order

1. Confirm the deployment already has a 64-hex-character `ENCRYPTION_KEY`, the Supabase service
   role configuration, and a strong `CRON_SECRET`.
2. Apply `supabase/migrations/20261023000000_custody_connections.sql`.
3. Deploy the application code. The deployment registers the Kraken quote provider and schedules
   `/api/cron/kraken-sync` for `23:59 UTC` each day.
4. Do not remove the old deployment until the migration and the new health checks both succeed.

## One-time fund configuration

1. Create or confirm the digital-asset holding and its investment transactions. These transactions
   are the book quantity used by reconciliation.
2. Create or update its `price_feeds` row with `kind = digital_asset`, `provider = kraken`, the
   Kraken-compatible symbol (for example `BTC`), `quote_currency = USD`, and the correct
   `active_from` date.
3. As a fund admin, call `POST /api/settings/kraken` with `action = connect`, the read-only Kraken
   API key and secret, and at least one position mapping containing `company_id`, `vehicle_id`,
   `price_feed_id`, `asset_code`, `auto_book`, and optionally `tolerance`.
4. Run the same endpoint with `action = run` and the returned `connection_id`. Confirm that the
   response shows an observation, a matching quantity, and the expected booking result.
5. Use `GET /api/settings/kraken` to monitor `last_synced_at` and `last_error`. Delete a connection
   with `DELETE /api/settings/kraken?connection_id=...` before rotating or retiring its key.

## Operational behavior

- A failed Kraken request, missing asset, failed observation, failed quote refresh, or thrown book
  operation marks the run failed and preserves a redacted error for the administrator.
- A quantity mismatch stores the custody observation but does not book a mark.
- Duplicate, closed-period, missing-price, and already-current marks use the existing portfolio
  booking safeguards and remain non-booking results.
- This integration updates internal observations and books only. Publishing NAV or performance to
  investors remains a separate, deliberate workflow.
