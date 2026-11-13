import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { Authorization } from '../src/authorization';
import { createApplication } from '../src/app';
import { loadConfig } from '../src/config';
import { HttpError, pkceChallenge } from '../src/security';

const enabled = process.env.TESSERA_INTEGRATION === 'true';
const suite = enabled ? describe : describe.skip;

suite('real PostgreSQL account/product authorization boundaries', () => {
  let authorization: Authorization;
  let userId: string;
  let close: () => Promise<void>;
  let headers: Headers;
  let sessionCreatedAt: Date;
  const fixtures = new Set<string>();

  beforeAll(async () => {
    const config = loadConfig();
    if (config.production || !['127.0.0.1','localhost'].includes(new URL(config.origin).hostname)) throw new Error('Integration requires an isolated local account deployment');
    const runtime = await createApplication(config);
    authorization = runtime.authorization;
    close = runtime.close;
    const email = `authorization-test-${randomBytes(12).toString('hex')}@example.test`;
    const password = randomBytes(24).toString('base64url');
    const registration = await runtime.auth.api.signUpEmail({ body: {email,password,name:'Authorization boundary fixture'} });
    userId = registration.user.id;
    const list = await (await fetch('http://127.0.0.1:18025/api/v1/messages')).json();
    const delivered = list.messages.find((row: {To:{Address:string}[]}) => row.To.some((recipient) => recipient.Address === email));
    if (!delivered) throw new Error('Real SMTP verification delivery missing');
    const message = await (await fetch(`http://127.0.0.1:18025/api/v1/message/${delivered.ID}`)).json();
    const token = new URL((message.Text as string).match(/https?:\/\/\S+/)![0]!).searchParams.get('token')!;
    await runtime.auth.api.verifyEmail({ query: {token} });
    const response = await runtime.auth.api.signInEmail({ body:{email,password},asResponse:true });
    headers = new Headers({Origin:config.origin,Cookie:response.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ')});
    const session = await runtime.auth.api.getSession({headers});
    if (!session) throw new Error('Actual browser session missing');
    sessionCreatedAt = new Date(session.session.createdAt);
  });

  afterAll(async () => {
    if (authorization && userId) await authorization.pool.query('DELETE FROM "user" WHERE id=$1', [userId]);
    if (authorization && fixtures.size) await authorization.pool.query('DELETE FROM authorization_requests WHERE id=ANY($1::uuid[])', [[...fixtures]]);
    if (close) await close();
  });

  async function approved(productId='techmino') {
    const verifier = randomBytes(32).toString('base64url');
    const redirectUri = 'http://127.0.0.1:19436/callback';
    const request = await authorization.begin({productId,clientKind:'native',redirectUri,codeChallenge:pkceChallenge(verifier),codeChallengeMethod:'S256',state:randomBytes(32).toString('base64url'),deviceLabel:'Concurrency fixture'});
    fixtures.add(request.requestId);
    const decision = await authorization.decide(request.requestId,userId,true,sessionCreatedAt);
    return {request, exchange:{productId,code:new URL(decision.redirectUri).searchParams.get('code')!,codeVerifier:verifier,redirectUri}};
  }

  test('concurrent authorization exchange admits exactly one grant', async () => {
    const fixture = await approved();
    const attempts = await Promise.allSettled([authorization.exchange(fixture.exchange),authorization.exchange(fixture.exchange)]);
    const accepted = attempts.filter((attempt) => attempt.status === 'fulfilled');
    expect(accepted.length).toBe(1);
    const rejected = attempts.find((attempt) => attempt.status === 'rejected');
    expect(rejected?.status).toBe('rejected');
    if (rejected?.status === 'rejected') expect((rejected.reason as HttpError).code).toBe('INVALID_CODE');
    if (accepted[0]?.status !== 'fulfilled') throw new Error('No actually issued credential');
    const session = accepted[0].value;
    expect((await authorization.validate('techmino',session.accessToken)).active).toBe(true);
    expect((await authorization.validate('techminoGalaxy',session.accessToken)).active).toBe(false);
    await authorization.revokeGrant(userId,session.grantId);
  });

  test('wrong proof, callback and product cannot consume a valid handoff', async () => {
    const fixture = await approved();
    for (const exchange of [
      {...fixture.exchange,codeVerifier:randomBytes(32).toString('base64url')},
      {...fixture.exchange,redirectUri:'http://127.0.0.1:19437/callback'},
      {...fixture.exchange,productId:'techminoGalaxy'},
    ]) {
      await expect(authorization.exchange(exchange)).rejects.toMatchObject({code:'INVALID_PROOF'});
    }
    const session = await authorization.exchange(fixture.exchange);
    expect((await authorization.validate('techmino',session.accessToken)).active).toBe(true);
    await authorization.revokeGrant(userId,session.grantId);
  });

  test('proof-bound cancel and expired codes never issue a grant', async () => {
    const cancelled = await approved();
    await expect(authorization.cancel(cancelled.request.requestId,randomBytes(32).toString('base64url'))).rejects.toMatchObject({code:'INVALID_PROOF'});
    await authorization.cancel(cancelled.request.requestId,cancelled.exchange.codeVerifier);
    await expect(authorization.exchange(cancelled.exchange)).rejects.toMatchObject({code:'INVALID_CODE'});
    const expired = await approved();
    await authorization.pool.query('UPDATE authorization_requests SET code_expires_at=now()-interval \'1 second\' WHERE id=$1',[expired.request.requestId]);
    await expect(authorization.exchange(expired.exchange)).rejects.toMatchObject({code:'INVALID_CODE'});
  });

  test('native concurrent refresh cannot leave a replayed grant active', async () => {
    const fixture = await approved();
    const initial = await authorization.exchange(fixture.exchange);
    const attempts = await Promise.allSettled([
      authorization.refresh('techmino',initial.refreshToken,'native'),
      authorization.refresh('techmino',initial.refreshToken,'native'),
    ]);
    const accepted = attempts.filter((attempt) => attempt.status === 'fulfilled');
    expect(accepted.length).toBe(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected').length).toBe(1);
    if (accepted[0]?.status !== 'fulfilled') throw new Error('Refresh never succeeded');
    expect((await authorization.validate('techmino',accepted[0].value.accessToken)).active).toBe(false);
    await expect(authorization.refresh('techmino',accepted[0].value.refreshToken,'native')).rejects.toMatchObject({code:'INVALID_CREDENTIAL'});
  });

  test('logout-all boundary rejects a delayed old browser authorization result', async () => {
    const fixture = await approved();
    await authorization.revokeUser(userId,undefined,false,true);
    await expect(authorization.exchange(fixture.exchange)).rejects.toMatchObject({code:'INVALID_CODE'});
    const verifier = randomBytes(32).toString('base64url');
    const pending = await authorization.begin({productId:'techmino',clientKind:'native',redirectUri:'http://127.0.0.1:19436/callback',codeChallenge:pkceChallenge(verifier),codeChallengeMethod:'S256',state:randomBytes(32).toString('base64url'),deviceLabel:'Late account callback'});
    fixtures.add(pending.requestId);
    await expect(authorization.decide(pending.requestId,userId,true,sessionCreatedAt)).rejects.toMatchObject({code:'REAUTHENTICATION_REQUIRED'});
  });
});
