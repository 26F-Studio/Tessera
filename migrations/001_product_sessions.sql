BEGIN;

CREATE TABLE IF NOT EXISTS tessera_migrations (
    version integer PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS account_control (
    user_id text PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT true,
    disabled_at timestamptz,
    CHECK ((enabled AND disabled_at IS NULL) OR (NOT enabled AND disabled_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS product_grants (
    id uuid PRIMARY KEY,
    user_id text NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
    product_id text NOT NULL CHECK (length(product_id) BETWEEN 1 AND 64),
    device_id uuid NOT NULL UNIQUE,
    device_label text NOT NULL CHECK (length(device_label) BETWEEN 1 AND 80),
    client_kind text NOT NULL CHECK (client_kind IN ('native', 'web')),
    capabilities jsonb NOT NULL CHECK (jsonb_typeof(capabilities) = 'array'),
    refresh_hash text NOT NULL UNIQUE CHECK (length(refresh_hash) = 64),
    previous_refresh_hash text CHECK (length(previous_refresh_hash) = 64),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS product_grants_user_product ON product_grants (user_id, product_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS product_grants_expiry ON product_grants (expires_at);
CREATE INDEX IF NOT EXISTS product_grants_previous_refresh ON product_grants (previous_refresh_hash) WHERE previous_refresh_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS product_access_credentials (
    token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
    grant_id uuid NOT NULL REFERENCES product_grants (id) ON DELETE CASCADE,
    expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS product_access_credentials_grant ON product_access_credentials (grant_id);
CREATE INDEX IF NOT EXISTS product_access_credentials_expiry ON product_access_credentials (expires_at);

CREATE TABLE IF NOT EXISTS authorization_requests (
    id uuid PRIMARY KEY,
    product_id text NOT NULL CHECK (length(product_id) BETWEEN 1 AND 64),
    client_kind text NOT NULL CHECK (client_kind IN ('native', 'web')),
    redirect_uri text NOT NULL CHECK (length(redirect_uri) <= 2048),
    code_challenge text NOT NULL CHECK (length(code_challenge) = 43),
    state text NOT NULL CHECK (length(state) BETWEEN 32 AND 128),
    device_label text NOT NULL CHECK (length(device_label) BETWEEN 1 AND 80),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','cancelled','consumed')),
    user_id text REFERENCES "user" (id) ON DELETE CASCADE,
    code_hash text UNIQUE CHECK (length(code_hash) = 64),
    code_expires_at timestamptz,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    grant_id uuid REFERENCES product_grants (id) ON DELETE SET NULL,
    CHECK ((status IN ('approved', 'consumed') AND user_id IS NOT NULL AND code_hash IS NOT NULL AND code_expires_at IS NOT NULL) OR status NOT IN ('approved', 'consumed'))
);
CREATE INDEX IF NOT EXISTS authorization_requests_user ON authorization_requests (user_id) WHERE status IN ('pending','approved');
CREATE INDEX IF NOT EXISTS authorization_requests_expiry ON authorization_requests (expires_at);

CREATE TABLE IF NOT EXISTS profiles (
    user_id text PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
    motto text NOT NULL DEFAULT '' CHECK (length(motto) <= 150),
    region text NOT NULL DEFAULT '' CHECK (region = '' OR region ~ '^[A-Z]{2}$'),
    avatar bytea CHECK (octet_length(avatar) <= 262144),
    avatar_version uuid,
    CHECK ((avatar IS NULL AND avatar_version IS NULL) OR (avatar IS NOT NULL AND avatar_version IS NOT NULL))
);
INSERT INTO tessera_migrations (version) VALUES (1) ON CONFLICT DO NOTHING;
COMMIT;
