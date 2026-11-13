BEGIN;
ALTER TABLE account_control ADD COLUMN IF NOT EXISTS authorization_reset_at timestamptz;
INSERT INTO tessera_migrations (version) VALUES (2) ON CONFLICT DO NOTHING;
COMMIT;
