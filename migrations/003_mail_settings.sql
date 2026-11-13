BEGIN;
-- Operator-edited mail delivery settings. The single row overrides the SMTP_*
-- environment defaults; secret columns hold AES-256-GCM sealed values
-- (12-byte IV, 16-byte tag, ciphertext) and are never returned by the API.
CREATE TABLE IF NOT EXISTS mail_settings (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    smtp_host text NOT NULL CHECK (length(smtp_host) BETWEEN 1 AND 253),
    smtp_port integer NOT NULL CHECK (smtp_port BETWEEN 1 AND 65535),
    smtp_secure boolean NOT NULL,
    smtp_user text CHECK (length(smtp_user) BETWEEN 1 AND 320),
    smtp_password bytea CHECK (octet_length(smtp_password) > 28),
    smtp_from text NOT NULL CHECK (length(smtp_from) BETWEEN 3 AND 320),
    brevo_api_key bytea CHECK (octet_length(brevo_api_key) > 28),
    quota_reserve integer NOT NULL DEFAULT 0 CHECK (quota_reserve BETWEEN 0 AND 1000),
    updated_by text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS mail_settings_audit (
    id bigserial PRIMARY KEY,
    actor_id text NOT NULL,
    action text NOT NULL CHECK (action IN ('update', 'reset')),
    changed_fields text[] NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO tessera_migrations (version) VALUES (3) ON CONFLICT DO NOTHING;
COMMIT;
