import { isIP } from 'node:net';
import { betterAuth } from 'better-auth';
import { cors } from '@elysiajs/cors';
import { Elysia, t } from 'elysia';
import { Pool, types } from 'pg';
import { Authorization, type ProductSession } from './authorization';
import { createAccountAuth } from './auth';
import type { ClientKind, Config } from './config';
import { Mailer } from './mail';
import { Profiles } from './profiles';
import { accessBearer, equalSecret, fail, HttpError, RateBudget } from './security';

// Better Auth normalizes bigint rate timestamps; pg's default decimal strings
// would concatenate when the library computes its retry deadline.
types.setTypeParser(types.builtins.INT8, BigInt);

const authPaths: Record<string, true> = {
  '/sign-up/email': true, '/sign-in/email': true, '/sign-in/email-otp': true,
  '/sign-out': true, '/get-session': true, '/request-password-reset': true,
  '/reset-password': true, '/send-verification-email': true, '/verify-email': true,
  '/change-password': true, '/change-email': true, '/list-sessions': true,
  '/revoke-session': true, '/revoke-sessions': true, '/revoke-other-sessions': true,
  '/update-user': true, '/set-password': true,
  '/email-otp/send-verification-otp': true, '/email-otp/check-verification-otp': true,
  '/email-otp/verify-email': true, '/email-otp/request-password-reset': true,
  '/email-otp/reset-password': true,
};
const uuid = t.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' });
const product = t.String({ minLength: 1, maxLength: 64 });
const verifier = t.String({ minLength: 43, maxLength: 128 });
const empty = t.Object({}, { additionalProperties: false });
const visible = (minLength: number, maxLength: number) => t.String({ minLength, maxLength, pattern: '^[^\\x00-\\x1f\\x7f]*$' });
const mailUpdate = t.Object({
  host: t.String({ minLength: 1, maxLength: 253, pattern: '^[A-Za-z0-9.-]+$' }),
  port: t.Integer({ minimum: 1, maximum: 65535 }), secure: t.Boolean(),
  user: visible(0, 320), password: t.Optional(visible(0, 512)), from: visible(3, 320),
  brevoApiKey: t.Optional(t.String({ maxLength: 512, pattern: '^[\\x21-\\x7e]*$' })),
  quotaReserve: t.Integer({ minimum: 0, maximum: 1000 }),
}, { additionalProperties: false });

export async function createApplication(config: Config) {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 8, connectionTimeoutMillis: 1500, statement_timeout: 1500, idleTimeoutMillis: 30000 });
  try {
    const privilege = await pool.query('SELECT rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user');
    if (privilege.rows[0]?.rolsuper || privilege.rows[0]?.rolcreatedb || privilege.rows[0]?.rolcreaterole) throw new Error('Runtime DATABASE_URL must use a non-administrative application role');
    const schema = await pool.query('SELECT version FROM tessera_migrations WHERE version=3');
    if (!schema.rowCount) throw new Error('Required Tessera migration is not applied');
  } catch (error) { await pool.end(); throw error; }
  const authorization = new Authorization(pool, config);
  const profiles = new Profiles(pool, config);
  const mail = new Mailer(pool, config);
  const { auth } = createAccountAuth(config, authorization, mail);
  const rates = new RateBudget();
  let draining = false;

  function browserOrigin(headers: Headers): void {
    if (!config.origins.includes(headers.get('origin') ?? '')) fail(403, 'ORIGIN_REJECTED', 'Browser origin is not authorized');
  }
  async function accountSession(headers: Headers, mutation = false, recent = false) {
    if (mutation) browserOrigin(headers);
    const session = await auth.api.getSession({ headers });
    if (!session) fail(401, 'AUTHENTICATION_REQUIRED', 'Sign in to your account');
    if (!await authorization.accountEnabled(session.user.id)) fail(403, 'ACCOUNT_DISABLED', 'Account disabled');
    if (recent && Date.now() - new Date(session.session.createdAt).getTime() > 600_000) fail(409, 'REAUTHENTICATION_REQUIRED', 'Sign in again to confirm this account operation');
    return session;
  }
  async function accountAdmin(headers: Headers, mutation = false) {
    const session = await accountSession(headers, mutation, mutation);
    if (!config.adminIds.has(session.user.id)) fail(403, 'ACCOUNT_ADMIN_REQUIRED', 'Account administration is required');
    return session;
  }
  function sessionCookieName(productId: string): string { return `${config.origin.startsWith('https://') ? '__Secure-' : ''}tessera.product.${productId}`; }
  function sessionCookie(productId: string, token: string, expiry: string): string {
    const secure = config.origin.startsWith('https://') ? '; Secure' : '';
    return `${sessionCookieName(productId)}=${token}; Path=/v1/products/${productId}/session; HttpOnly; SameSite=Lax; Expires=${new Date(expiry).toUTCString()}${secure}`;
  }
  function refreshCredential(headers: Headers, body: { refreshToken?: string } | null | undefined, productId: string): { token: string; kind: ClientKind } {
    if (body?.refreshToken) return { token: body.refreshToken, kind: 'native' };
    browserOrigin(headers);
    const name = sessionCookieName(productId);
    const cookie = (headers.get('cookie') ?? '').split(';').map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
    if (!cookie) fail(401, 'AUTHENTICATION_REQUIRED', 'Product session is missing');
    return { token: cookie.slice(name.length + 1), kind: 'web' };
  }
  function productReply(session: ProductSession): Response {
    const { clientKind, refreshToken, ...body } = session;
    if (clientKind === 'web') return Response.json(body, { headers: { 'Set-Cookie': sessionCookie(session.productId, refreshToken, session.refreshExpiresAt), 'Cache-Control': 'no-store' } });
    return Response.json({ ...body, refreshToken }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const app = new Elysia({ name: 'Tessera', normalize: false });
  function clientIp(request: Request): string {
    const peer = app.server?.requestIP(request)?.address ?? '';
    const forwarded = request.headers.get('x-real-ip');
    return config.trustedProxyIps.has(peer) && forwarded && isIP(forwarded) ? forwarded : peer;
  }
  app
    .use(cors({ origin: config.origins, credentials: true, methods: ['GET','POST','PATCH','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'], exposeHeaders: ['ETag'] }))
    .onRequest(({ request, set }) => {
      set.headers['Cache-Control'] = 'no-store';
      set.headers['X-Content-Type-Options'] = 'nosniff';
      const length = Number(request.headers.get('content-length') ?? 0);
      if (length > 262144) fail(413, 'BODY_LIMIT', 'Request body exceeds the configured limit');
      if (request.method !== 'GET' && request.method !== 'HEAD' && request.method !== 'OPTIONS' && request.headers.has('cookie')) browserOrigin(request.headers);
      if (request.method !== 'OPTIONS' && !new URL(request.url).pathname.startsWith('/v1/internal/')) {
        rates.take(clientIp(request) || 'internal', 600);
      }
      if (draining && request.method !== 'GET') fail(503, 'SERVICE_DRAINING', 'Service is draining');
    })
    .onError(({ code, error, set }) => {
      if (error instanceof HttpError) { set.status = error.status; return { error: { code: error.code, message: error.message } }; }
      if (code === 'VALIDATION' || code === 'PARSE') { set.status = 400; return { error: { code: 'INVALID_REQUEST', message: 'Request does not match the supported contract' } }; }
      if (code === 'NOT_FOUND') { set.status = 404; return { error: { code: 'NOT_FOUND', message: 'Endpoint not found' } }; }
      console.error(JSON.stringify({ component: 'tessera', event: 'request-failed', category: code }));
      set.status = 503;
      return { error: { code: 'SERVICE_UNAVAILABLE', message: 'Operation unavailable; refresh current state before retrying' } };
    })
    .get('/health/live', () => ({ status: 'live' }))
    .get('/health/ready', async () => {
      if (draining) fail(503, 'SERVICE_DRAINING', 'Service is draining');
      await pool.query('SELECT 1');
      return { status: 'ready' };
    })
    .all('/api/auth/*', ({ request }) => {
      const path = new URL(request.url).pathname.slice('/api/auth'.length);
      const resetCallback = request.method === 'GET' && /^\/reset-password\/[A-Za-z0-9_-]{24}$/.test(path);
      if (!authPaths[path] && !resetCallback) fail(404, 'NOT_FOUND', 'Endpoint not found');
      const headers = new Headers(request.headers);
      for (const name of ['x-forwarded-for', 'x-real-ip', 'cf-connecting-ip', 'x-tessera-client-ip']) headers.delete(name);
      const address = clientIp(request);
      if (address) headers.set('x-tessera-client-ip', address);
      return auth.handler(new Request(request, { headers }));
    }, { parse: 'none' })
    .get('/v1/products', () => ({ products: Object.values(config.products).map(({ mobileRedirectUri: _, ...item }) => item) }))
    .post('/v1/authorization/requests', ({ body, set }) => {
      set.status = 201;
      return authorization.begin(body);
    }, {
      body: t.Object({ productId: product, clientKind: t.Union([t.Literal('native'),t.Literal('web')]), redirectUri: t.String({ minLength: 1, maxLength: 2048 }), codeChallenge: t.String({ minLength: 43, maxLength: 43 }), codeChallengeMethod: t.Literal('S256'), state: t.String({ minLength: 32, maxLength: 128 }), deviceLabel: t.String({ minLength: 1, maxLength: 80 }) }, { additionalProperties: false }),
    })
    .get('/v1/authorization/requests/:id', async ({ request, params }) => {
      await accountSession(request.headers);
      return authorization.describe(params.id);
    }, { params: t.Object({ id: uuid }) })
    .post('/v1/authorization/requests/:id/decision', async ({ request, params, body }) => {
      const session = await accountSession(request.headers, true);
      return authorization.decide(params.id, session.user.id, body.approved, new Date(session.session.createdAt));
    }, { params: t.Object({ id: uuid }), body: t.Object({ approved: t.Boolean() }, { additionalProperties: false }) })
    .post('/v1/authorization/requests/:id/cancel', ({ params, body }) => authorization.cancel(params.id, body.codeVerifier), {
      params: t.Object({ id: uuid }), body: t.Object({ codeVerifier: verifier }, { additionalProperties: false }),
    })
    .post('/v1/authorization/exchange', async ({ body }) => productReply(await authorization.exchange(body)), {
      body: t.Object({ productId: product, code: t.String({ maxLength: 128 }), codeVerifier: verifier, redirectUri: t.String({ minLength: 1, maxLength: 2048 }) }, { additionalProperties: false }),
    })
    .post('/v1/products/:product/session/refresh', async ({ request, params, body }) => {
      authorization.product(params.product);
      const credential = refreshCredential(request.headers, body, params.product);
      return productReply(await authorization.refresh(params.product, credential.token, credential.kind));
    }, { params: t.Object({ product }), body: t.Optional(t.Object({ refreshToken: t.Optional(t.String({ maxLength: 128 })) }, { additionalProperties: false })) })
    .post('/v1/products/:product/session/logout', async ({ request, params, body }) => {
      authorization.product(params.product);
      const credential = refreshCredential(request.headers, body, params.product);
      await authorization.logout(params.product, credential.token, credential.kind);
      return Response.json({ success: true }, { headers: credential.kind === 'web' ? { 'Set-Cookie': sessionCookie(params.product, '', '1970-01-01T00:00:00Z') } : {} });
    }, { params: t.Object({ product }), body: t.Optional(t.Object({ refreshToken: t.Optional(t.String({ maxLength: 128 })) }, { additionalProperties: false })) })
    .get('/v1/grants', async ({ request }) => authorization.list((await accountSession(request.headers)).user.id))
    .post('/v1/grants/:id/revoke', async ({ request, params }) => {
      await authorization.revokeGrant((await accountSession(request.headers, true)).user.id, params.id);
      return { success: true };
    }, { params: t.Object({ id: uuid }), body: t.Optional(empty) })
    .post('/v1/products/:product/withdraw', async ({ request, params }) => {
      await authorization.revokeUser((await accountSession(request.headers, true)).user.id, params.product);
      return { success: true };
    }, { params: t.Object({ product }), body: t.Optional(empty) })
    .post('/v1/account/logout-all', async ({ request }) => {
      const session = await accountSession(request.headers, true);
      await authorization.revokeUser(session.user.id, undefined, false, true);
      await auth.api.revokeSessions({ headers: request.headers });
      return auth.api.signOut({ headers: request.headers, asResponse: true });
    }, { body: t.Optional(empty) })
    .get('/v1/profile', async ({ request }) => profiles.get((await accountSession(request.headers)).user.id, true))
    .patch('/v1/profile', async ({ request, body }) => {
      const session = await accountSession(request.headers, true);
      if (body.name !== undefined) await auth.api.updateUser({ headers: request.headers, body: { name: body.name } });
      await profiles.update(session.user.id, body);
      return profiles.get(session.user.id, true);
    }, { body: t.Object({ name: t.Optional(t.String({ minLength: 2, maxLength: 32, pattern: '^[^\\x00-\\x1f\\x7f]+$' })), motto: t.Optional(t.String({ maxLength: 150, pattern: '^[^\\x00-\\x1f\\x7f]*$' })), region: t.Optional(t.String({ pattern: '^([A-Z]{2})?$' })) }, { additionalProperties: false }) })
    .get('/v1/profiles/:id', ({ params }) => profiles.get(params.id), { params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }) })
    .put('/v1/profile/avatar', async ({ request }) => {
      const session = await accountSession(request.headers, true);
      await profiles.setAvatar(session.user.id, new Uint8Array(await request.arrayBuffer()));
      return profiles.get(session.user.id, true);
    }, { parse: 'none' })
    .get('/v1/profiles/:id/avatar', ({ request, params }) => profiles.avatar(params.id, request.headers.get('if-none-match')), { params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }) })
    .post('/v1/account/deactivate', async ({ request }) => {
      const session = await accountSession(request.headers, true, true);
      await authorization.revokeUser(session.user.id, undefined, true);
      await auth.api.revokeSessions({ headers: request.headers });
      return auth.api.signOut({ headers: request.headers, asResponse: true });
    }, { body: t.Optional(empty) })
    .post('/v1/admin/accounts/:id/disable', async ({ request, params }) => {
      await accountAdmin(request.headers, true);
      await profiles.get(params.id);
      await authorization.revokeUser(params.id, undefined, true);
      return { success: true };
    }, { params: t.Object({ id: t.String({ minLength: 1, maxLength: 128 }) }), body: t.Optional(empty) })
    .get('/v1/admin/mail', async ({ request }) => {
      await accountAdmin(request.headers);
      return mail.status();
    })
    .put('/v1/admin/mail', async ({ request, body }) => mail.update((await accountAdmin(request.headers, true)).user.id, body), { body: mailUpdate })
    .delete('/v1/admin/mail', async ({ request }) => mail.reset((await accountAdmin(request.headers, true)).user.id), { body: t.Optional(empty) })
    .post('/v1/internal/authorizations/validate', async ({ request, body }) => {
      const credential = accessBearer(request.headers);
      const resource = config.resourceKeys.find((item) => (item.validUntil === undefined || item.validUntil > Date.now()) && equalSecret(credential, item.secret));
      if (!resource || !resource.products.some((id) => id === body.productId)) fail(401, 'RESOURCE_AUTHENTICATION_REQUIRED', 'Authorized resource validation is required');
      rates.take(`resource:${resource.id}`, 6000);
      return authorization.validate(body.productId, body.accessToken);
    }, { body: t.Object({ productId: product, accessToken: t.String({ maxLength: 256 }) }, { additionalProperties: false }) });

  const sweepTimer = setInterval(() => { void authorization.sweep().catch(() => console.error('Tessera credential cleanup unavailable')); }, 60_000);
  sweepTimer.unref();
  return {
    app, pool, auth, authorization,
    async close() { draining = true; clearInterval(sweepTimer); if (app.server) await app.stop(false); await pool.end(); },
  };
}
