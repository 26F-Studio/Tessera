import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { ClientKind, Config, Product, ProductId } from './config';
import { equalSecret, fail, pkceChallenge, secretToken, tokenHash, tokenLooksValid } from './security';

interface RequestRow {
  id: string; product_id: ProductId; client_kind: ClientKind; redirect_uri: string; code_challenge: string;
  state: string; device_label: string; status: string; user_id: string | null;
  code_hash: string | null; code_expires_at: Date | null; expires_at: Date; grant_id: string | null;
}
interface GrantRow {
  id: string; user_id: string; product_id: ProductId; device_id: string; device_label: string;
  client_kind: ClientKind; capabilities: string[]; refresh_hash: string;
  previous_refresh_hash: string | null; expires_at: Date; revoked_at: Date | null;
}
export interface ProductSession {
  accessToken: string; refreshToken: string; expiresAt: string; refreshExpiresAt: string;
  grantId: string; deviceId: string; productId: ProductId; capabilities: string[];
  user: { id: string; name: string }; clientKind: ClientKind;
}
interface Account {
  id: string; name: string; enabled: boolean; emailVerified: boolean;
  authorizationResetAt: Date | null;
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export class Authorization {
  constructor(readonly pool: Pool, private readonly config: Config) {}

  product(id: string): Product {
    if (!Object.hasOwn(this.config.products, id)) fail(404, 'PRODUCT_NOT_FOUND', 'Product not found');
    return this.config.products[id as ProductId];
  }

  private async lockAccount(client: PoolClient, userId: string): Promise<Account> {
    await client.query('INSERT INTO account_control (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
    const result = await client.query<Account>(
      'SELECT u.id,u.name,u."emailVerified",c.enabled,c.authorization_reset_at AS "authorizationResetAt" FROM "user" u JOIN account_control c ON c.user_id=u.id WHERE u.id=$1 FOR UPDATE OF c', [userId],
    );
    const account = result.rows[0];
    if (!account?.enabled || !account.emailVerified) fail(403, 'ACCOUNT_UNAVAILABLE', 'Account is not available for product authorization');
    return account;
  }

  async accountEnabled(userId: string): Promise<boolean> {
    const result = await this.pool.query('SELECT enabled FROM account_control WHERE user_id=$1', [userId]);
    return result.rows[0]?.enabled !== false;
  }

  async createAccountState(userId: string): Promise<void> {
    await this.pool.query('INSERT INTO account_control (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
  }

  async begin(input: { productId: string; clientKind: ClientKind; redirectUri: string; codeChallenge: string; codeChallengeMethod: string; state: string; deviceLabel: string }) {
    const product = this.product(input.productId);
    if (input.codeChallengeMethod !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(input.codeChallenge) || !/^[A-Za-z0-9_-]{32,128}$/.test(input.state)) fail(400, 'INVALID_AUTHORIZATION', 'Invalid authorization request');
    let redirect: URL;
    try { redirect = new URL(input.redirectUri); }
    catch { fail(400, 'INVALID_CALLBACK', 'Callback is not registered'); }
    if (redirect.username || redirect.password || redirect.search || redirect.hash || input.redirectUri.length > 2048) fail(400, 'INVALID_CALLBACK', 'Callback is not registered');
    let permitted = false;
    if (input.clientKind === 'web') permitted = product.webRedirectUris.includes(input.redirectUri);
    else {
      const loopback = redirect.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(redirect.hostname) && redirect.port !== '' && Number(redirect.port) > 0 && redirect.pathname === '/callback';
      permitted = loopback || input.redirectUri === product.mobileRedirectUri;
    }
    if (!permitted) fail(400, 'INVALID_CALLBACK', 'Callback is not registered');
    const deviceLabel = input.deviceLabel.trim();
    if (!deviceLabel || deviceLabel.length > 80 || /[\u0000-\u001f\u007f]/.test(deviceLabel)) fail(400, 'INVALID_DEVICE_LABEL', 'Invalid device label');
    return transaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(742615126)');
      const capacity = await client.query('SELECT count(*)::int AS n FROM authorization_requests WHERE expires_at>now() AND status IN (\'pending\',\'approved\')');
      if (capacity.rows[0].n >= 1000) fail(503, 'ADMISSION_BUSY', 'Authorization capacity exhausted');
      const requestId = randomUUID();
      const expiresAt = new Date(Date.now() + 180_000);
      await client.query(
        'INSERT INTO authorization_requests (id,product_id,client_kind,redirect_uri,code_challenge,state,device_label,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
        [requestId, product.id, input.clientKind, input.redirectUri, input.codeChallenge, input.state, deviceLabel, expiresAt],
      );
      return { requestId, authorizationUrl: `${this.config.origin}/authorize/${requestId}`, expiresAt: expiresAt.toISOString() };
    });
  }

  async describe(requestId: string) {
    const { rows } = await this.pool.query<RequestRow>('SELECT * FROM authorization_requests WHERE id=$1', [requestId]);
    const row = rows[0];
    if (!row) fail(404, 'AUTHORIZATION_NOT_FOUND', 'Authorization request not found');
    const product = this.product(row.product_id);
    return {
      requestId, product: { id: product.id, name: product.name, capabilities: product.capabilities },
      deviceLabel: row.device_label, redirectUri: row.redirect_uri,
      status: row.expires_at.getTime() <= Date.now() && row.status === 'pending' ? 'expired' : row.status,
      expiresAt: row.expires_at.toISOString(),
    };
  }

  async decide(requestId: string, userId: string, approved: boolean, sessionCreatedAt: Date) {
    return transaction(this.pool, async (client) => {
      const account = await this.lockAccount(client, userId);
      if (account.authorizationResetAt && sessionCreatedAt.getTime() <= account.authorizationResetAt.getTime()) fail(409, 'REAUTHENTICATION_REQUIRED', 'Sign in again before authorizing another product session');
      const { rows } = await client.query<RequestRow>('SELECT * FROM authorization_requests WHERE id=$1 FOR UPDATE', [requestId]);
      const row = rows[0];
      if (!row) fail(404, 'AUTHORIZATION_NOT_FOUND', 'Authorization request not found');
      if (row.expires_at.getTime() <= Date.now()) fail(410, 'AUTHORIZATION_EXPIRED', 'Authorization request expired');
      if (row.status !== 'pending') fail(409, 'AUTHORIZATION_TERMINAL', 'Authorization request already ended');
      const code = approved ? secretToken('tc') : null;
      await client.query(
        'UPDATE authorization_requests SET status=$2,user_id=$3,code_hash=$4,code_expires_at=$5 WHERE id=$1',
        [requestId, approved ? 'approved' : 'denied', userId, code ? tokenHash(code) : null, code ? new Date(Date.now() + 60_000) : null],
      );
      const callback = new URL(row.redirect_uri);
      callback.searchParams.set('state', row.state);
      callback.searchParams.set('issuer', this.config.origin);
      callback.searchParams.set(approved ? 'code' : 'error', code ?? 'access_denied');
      return { redirectUri: callback.toString() };
    });
  }

  async cancel(requestId: string, verifier: string) {
    return transaction(this.pool, async (client) => {
      const { rows } = await client.query<RequestRow>('SELECT * FROM authorization_requests WHERE id=$1 FOR UPDATE', [requestId]);
      const row = rows[0];
      if (!row || !equalSecret(pkceChallenge(verifier), row.code_challenge)) fail(400, 'INVALID_PROOF', 'Invalid authorization proof');
      if (row.status === 'consumed') fail(409, 'AUTHORIZATION_TERMINAL', 'Authorization request already consumed');
      await client.query('UPDATE authorization_requests SET status=\'cancelled\',code_hash=NULL,code_expires_at=NULL WHERE id=$1', [requestId]);
      return { status: 'cancelled' };
    });
  }

  private async issueAccess(client: PoolClient, grant: GrantRow, account: Account, refreshToken: string): Promise<ProductSession> {
    await client.query('DELETE FROM product_access_credentials WHERE grant_id=$1 AND expires_at<=now()', [grant.id]);
    const live = await client.query('SELECT count(*)::int AS n FROM product_access_credentials WHERE grant_id=$1', [grant.id]);
    if (live.rows[0].n >= 32) fail(429, 'SESSION_RATE_LIMITED', 'Too many live access credentials; wait for expiry');
    const accessToken = secretToken('ta');
    const expiresAt = new Date(Math.min(Date.now() + 300_000, grant.expires_at.getTime()));
    await client.query('INSERT INTO product_access_credentials (token_hash,grant_id,expires_at) VALUES ($1,$2,$3)', [tokenHash(accessToken), grant.id, expiresAt]);
    return {
      accessToken, refreshToken, expiresAt: expiresAt.toISOString(), refreshExpiresAt: grant.expires_at.toISOString(),
      grantId: grant.id, deviceId: grant.device_id, productId: grant.product_id, capabilities: grant.capabilities,
      user: { id: account.id, name: account.name }, clientKind: grant.client_kind,
    };
  }

  async exchange(input: { productId: string; code: string; codeVerifier: string; redirectUri: string }): Promise<ProductSession> {
    this.product(input.productId);
    if (!tokenLooksValid(input.code, 'tc')) fail(400, 'INVALID_CODE', 'Invalid authorization code');
    const hash = tokenHash(input.code);
    const initial = await this.pool.query<RequestRow>('SELECT * FROM authorization_requests WHERE code_hash=$1', [hash]);
    const subject = initial.rows[0]?.user_id;
    if (!subject) fail(400, 'INVALID_CODE', 'Invalid authorization code');
    return transaction(this.pool, async (client) => {
      const account = await this.lockAccount(client, subject);
      const { rows } = await client.query<RequestRow>('SELECT * FROM authorization_requests WHERE code_hash=$1 FOR UPDATE', [hash]);
      const row = rows[0];
      if (!row || row.status !== 'approved' || row.user_id !== account.id || !row.code_expires_at || row.code_expires_at.getTime() <= Date.now()) fail(400, 'INVALID_CODE', 'Authorization code is expired or already used');
      if (row.product_id !== input.productId || row.redirect_uri !== input.redirectUri || !equalSecret(pkceChallenge(input.codeVerifier), row.code_challenge)) fail(400, 'INVALID_PROOF', 'Authorization exchange binding does not match');
      const count = await client.query('SELECT count(*)::int AS n FROM product_grants WHERE user_id=$1 AND product_id=$2 AND revoked_at IS NULL AND expires_at>now()', [account.id, row.product_id]);
      if (count.rows[0].n >= 5) fail(409, 'DEVICE_LIMIT', 'Revoke an existing product device grant before adding another');
      const refreshToken = secretToken('tr');
      const grant: GrantRow = {
        id: randomUUID(), user_id: account.id, product_id: row.product_id, device_id: randomUUID(), device_label: row.device_label,
        client_kind: row.client_kind, capabilities: this.product(row.product_id).capabilities,
        refresh_hash: tokenHash(refreshToken), previous_refresh_hash: null, expires_at: new Date(Date.now() + 2_592_000_000), revoked_at: null,
      };
      await client.query(
        'INSERT INTO product_grants (id,user_id,product_id,device_id,device_label,client_kind,capabilities,refresh_hash,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [grant.id, grant.user_id, grant.product_id, grant.device_id, grant.device_label, grant.client_kind, JSON.stringify(grant.capabilities), grant.refresh_hash, grant.expires_at],
      );
      const session = await this.issueAccess(client, grant, account, refreshToken);
      await client.query('UPDATE authorization_requests SET status=\'consumed\',grant_id=$2 WHERE id=$1', [row.id, grant.id]);
      return session;
    });
  }

  async refresh(productId: string, refreshToken: string, kind: ClientKind): Promise<ProductSession> {
    this.product(productId);
    if (!tokenLooksValid(refreshToken, 'tr')) fail(401, 'INVALID_CREDENTIAL', 'Invalid product session');
    const hash = tokenHash(refreshToken);
    const initial = await this.pool.query<GrantRow>('SELECT * FROM product_grants WHERE product_id=$1 AND (refresh_hash=$2 OR previous_refresh_hash=$2)', [productId, hash]);
    const subject = initial.rows[0]?.user_id;
    if (!subject) fail(401, 'INVALID_CREDENTIAL', 'Invalid product session');
    const result = await transaction(this.pool, async (client) => {
      const account = await this.lockAccount(client, subject);
      const { rows } = await client.query<GrantRow>('SELECT * FROM product_grants WHERE id=$1 FOR UPDATE', [initial.rows[0]!.id]);
      const grant = rows[0];
      if (!grant || grant.client_kind !== kind || grant.product_id !== productId || grant.revoked_at || grant.expires_at.getTime() <= Date.now()) fail(401, 'INVALID_CREDENTIAL', 'Product session expired or ended');
      if (hash !== grant.refresh_hash) {
        if (hash === grant.previous_refresh_hash && kind === 'native') await client.query('UPDATE product_grants SET revoked_at=now() WHERE id=$1', [grant.id]);
        return null;
      }
      const next = kind === 'native' ? secretToken('tr') : refreshToken;
      const session = await this.issueAccess(client, grant, account, next);
      await client.query(
        'UPDATE product_grants SET previous_refresh_hash=CASE WHEN client_kind=\'native\' THEN refresh_hash ELSE NULL END,refresh_hash=$2,last_used_at=now() WHERE id=$1', [grant.id, tokenHash(next)],
      );
      return session;
    });
    if (!result) fail(401, 'REFRESH_REPLAYED', 'Product refresh credential was already consumed; sign in again');
    return result;
  }

  async logout(productId: string, refreshToken: string, kind: ClientKind): Promise<void> {
    this.product(productId);
    if (!tokenLooksValid(refreshToken, 'tr')) fail(401, 'INVALID_CREDENTIAL', 'Invalid product session');
    const result = await this.pool.query(
      'UPDATE product_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE product_id=$1 AND client_kind=$2 AND refresh_hash=$3 RETURNING id', [productId, kind, tokenHash(refreshToken)],
    );
    if (!result.rowCount) fail(401, 'INVALID_CREDENTIAL', 'Invalid product session');
  }

  async list(userId: string) {
    const { rows } = await this.pool.query(
      'SELECT id,product_id AS "productId",device_label AS "deviceLabel",created_at AS "createdAt",expires_at AS "expiresAt",last_used_at AS "lastUsedAt" FROM product_grants WHERE user_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC', [userId],
    );
    return { grants: rows };
  }

  async revokeGrant(userId: string, grantId: string): Promise<void> {
    const result = await this.pool.query('UPDATE product_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id', [grantId, userId]);
    if (!result.rowCount) fail(404, 'GRANT_NOT_FOUND', 'Device grant not found');
  }

  async revokeUser(userId: string, productId?: string, disable = false, resetAuthorizations = false): Promise<void> {
    if (productId !== undefined) this.product(productId);
    await transaction(this.pool, async (client) => {
      await client.query('INSERT INTO account_control (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
      await client.query('SELECT user_id FROM account_control WHERE user_id=$1 FOR UPDATE', [userId]);
      if (disable) await client.query('UPDATE account_control SET enabled=false,disabled_at=now() WHERE user_id=$1', [userId]);
      if (resetAuthorizations) await client.query('UPDATE account_control SET authorization_reset_at=clock_timestamp() WHERE user_id=$1', [userId]);
      await client.query('UPDATE product_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1 AND ($2::text IS NULL OR product_id=$2)', [userId, productId ?? null]);
      await client.query('UPDATE authorization_requests SET status=\'cancelled\',code_hash=NULL,code_expires_at=NULL WHERE user_id=$1 AND status IN (\'pending\',\'approved\') AND ($2::text IS NULL OR product_id=$2)', [userId, productId ?? null]);
    });
  }

  async validate(productId: string, accessToken: string) {
    this.product(productId);
    if (!tokenLooksValid(accessToken, 'ta')) return { active: false as const };
    const { rows } = await this.pool.query(
      'SELECT g.user_id AS subject,u.name,g.product_id AS "productId",g.id AS "grantId",g.device_id AS "deviceId",g.capabilities,a.expires_at AS "expiresAt",clock_timestamp() AS "validatedAt" FROM product_access_credentials a JOIN product_grants g ON g.id=a.grant_id JOIN "user" u ON u.id=g.user_id LEFT JOIN account_control c ON c.user_id=u.id WHERE a.token_hash=$1 AND g.product_id=$2 AND a.expires_at>clock_timestamp() AND g.expires_at>clock_timestamp() AND g.revoked_at IS NULL AND COALESCE(c.enabled,true) AND u."emailVerified"',
      [tokenHash(accessToken), productId],
    );
    return rows[0] ? { active: true as const, ...rows[0] } : { active: false as const };
  }

  async sweep(): Promise<void> {
    await this.pool.query('DELETE FROM product_access_credentials WHERE expires_at<=now()');
    await this.pool.query('DELETE FROM authorization_requests WHERE expires_at<now()-interval \'10 minutes\'');
    await this.pool.query('DELETE FROM product_grants WHERE expires_at<now()-interval \'1 day\' OR revoked_at<now()-interval \'1 day\'');
  }
}
