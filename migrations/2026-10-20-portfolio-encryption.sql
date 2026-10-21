-- Add columns first, deploy the new Worker, then run the authenticated backfill.
-- Do not clear the legacy columns here: encryption requires the Worker secret.
ALTER TABLE holdings ADD COLUMN data_enc TEXT;
ALTER TABLE cash_balances ADD COLUMN data_enc TEXT;
ALTER TABLE portfolio_snapshots ADD COLUMN data_enc TEXT;
ALTER TABLE portfolio_plans ADD COLUMN data_enc TEXT;
