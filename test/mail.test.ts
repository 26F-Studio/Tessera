import { describe, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import { loadConfig } from '../src/config';
import { Mailer } from '../src/mail';

const config = loadConfig({
  PUBLIC_ORIGIN: 'http://127.0.0.1:17436', BETTER_AUTH_SECRET: 'x'.repeat(32), DATABASE_URL: 'postgres://unused',
  RESOURCE_KEYS: JSON.stringify([{ id: 'test', secret: 'y'.repeat(32), products: ['techmino'] }]),
  SMTP_HOST: 'smtp.invalid', SMTP_FROM: 'Test <no-reply@example.test>',
});

function mailer(reserve: number, reply: () => Promise<Response>, secret = config.secret) {
  let row: Record<string, unknown> | undefined;
  const pool = { query: async () => ({ rows: row ? [row] : [] }) } as unknown as Pool;
  const sealer = new Mailer(pool, { ...config, secret }) as unknown as { seal(value: string, column: string): Buffer };
  row = {
    smtp_host: 'smtp.invalid', smtp_port: 587, smtp_secure: false, smtp_user: null, smtp_password: null, smtp_from: 'a@b.c',
    brevo_api_key: sealer.seal('xkeysib-test', 'brevo_api_key'), quota_reserve: reserve, updated_by: 'admin', updated_at: new Date(),
  };
  const requests: string[] = [];
  const instance = new Mailer(pool, config, (async (_url: string, init: RequestInit) => {
    requests.push(new Headers(init.headers).get('api-key')!);
    return reply();
  }) as unknown as typeof fetch);
  return { instance, requests };
}
const account = (plan: unknown[]) => async () => Response.json({ plan, relay: { enabled: true } });

describe('provider quota admission', () => {
  test('refuses mail once email credits reach the reserve and ignores SMS credits', async () => {
    const exhausted = mailer(0, account([{ type: 'free', creditsType: 'sendLimit', credits: 0 }, { type: 'sms', creditsType: 'sendLimit', credits: 50 }]));
    expect(await exhausted.instance.admit()).toBe(false);
    expect(exhausted.requests).toEqual(['xkeysib-test']);
    const reserved = mailer(5, account([{ type: 'free', creditsType: 'sendLimit', credits: 5 }]));
    expect(await reserved.instance.admit()).toBe(false);
    const available = mailer(5, account([{ type: 'free', creditsType: 'sendLimit', credits: 6 }]));
    expect(await available.instance.admit()).toBe(true);
  });

  test('admits mail when the quota lookup fails', async () => {
    expect(await mailer(0, async () => new Response('{}', { status: 401 })).instance.admit()).toBe(true);
    expect(await mailer(0, async () => { throw new TypeError('offline'); }).instance.admit()).toBe(true);
    expect(await mailer(0, account([])).instance.admit()).toBe(true);
  });

  test('stored secrets sealed under another auth secret are ignored', async () => {
    const foreign = mailer(0, account([{ type: 'free', creditsType: 'sendLimit', credits: 0 }]), 'z'.repeat(32));
    expect(await foreign.instance.admit()).toBe(true);
    expect(foreign.requests).toEqual([]);
  });
});
