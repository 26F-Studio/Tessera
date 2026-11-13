import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import type { Pool } from 'pg';
import type { Config } from './config';
import { fail } from './security';

export interface SmtpSettings { host: string; port: number; secure: boolean; user?: string; password?: string; from: string }
interface Settings {
  smtp: SmtpSettings;
  brevoApiKey?: string;
  quotaReserve: number;
  source: 'environment' | 'database';
  storedUnreadable: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}
/** Omitted secrets keep their current value; an empty string clears them. */
export interface MailUpdate { host: string; port: number; secure: boolean; user: string; password?: string; from: string; brevoApiKey?: string; quotaReserve: number }
export type Quota =
  | { status: 'unconfigured' }
  | { status: 'available'; remaining: number; plans: { type: string; credits: number }[]; relayEnabled: boolean; checkedAt: string }
  | { status: 'unavailable'; reason: string };

const brevoAccount = 'https://api.brevo.com/v3/account';
const quotaTtl = 10_000;

function isEmailPlan(value: unknown): value is { type: string; credits: number } {
  const plan = value as Record<string, unknown> | null;
  return !!plan && plan.creditsType === 'sendLimit' && typeof plan.type === 'string' && plan.type !== 'sms'
    && typeof plan.credits === 'number' && Number.isFinite(plan.credits);
}

/**
 * Mail delivery with operator-editable settings. A stored row overrides the
 * SMTP_* environment defaults; secrets are sealed with a key derived from
 * BETTER_AUTH_SECRET. Settings are read per message so every instance follows
 * the latest saved row without a reload step.
 */
export class Mailer {
  private readonly key: Buffer;
  private cached?: { apiKey: string; quota: Quota; at: number };
  private pending?: { apiKey: string; promise: Promise<Quota> };

  constructor(private readonly pool: Pool, private readonly config: Config, private readonly request: typeof fetch = fetch) {
    this.key = Buffer.from(hkdfSync('sha256', config.secret, 'tessera-mail-settings', 'stored-secrets-v1', 32));
  }

  private seal(value: string, column: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(column));
    const sealed = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), sealed]);
  }

  private open(value: Buffer, column: string): string {
    const decipher = createDecipheriv('aes-256-gcm', this.key, value.subarray(0, 12));
    decipher.setAAD(Buffer.from(column));
    decipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
  }

  private async settings(): Promise<Settings> {
    const { host, port, secure, user, password, from } = this.config.smtp;
    const environment: Settings = { smtp: { host, port, secure, user, password, from }, quotaReserve: 0, source: 'environment', storedUnreadable: false, updatedAt: null, updatedBy: null };
    const { rows } = await this.pool.query('SELECT smtp_host,smtp_port,smtp_secure,smtp_user,smtp_password,smtp_from,brevo_api_key,quota_reserve,updated_by,updated_at FROM mail_settings');
    const row = rows[0];
    if (!row) return environment;
    try {
      return {
        smtp: {
          host: row.smtp_host, port: row.smtp_port, secure: row.smtp_secure, user: row.smtp_user ?? undefined,
          password: row.smtp_password ? this.open(row.smtp_password, 'smtp_password') : undefined, from: row.smtp_from,
        },
        brevoApiKey: row.brevo_api_key ? this.open(row.brevo_api_key, 'brevo_api_key') : undefined,
        quotaReserve: row.quota_reserve, source: 'database', storedUnreadable: false,
        updatedAt: row.updated_at.toISOString(), updatedBy: row.updated_by,
      };
    } catch {
      console.error(JSON.stringify({ component: 'mail', event: 'stored-settings-unreadable' }));
      return { ...environment, storedUnreadable: true };
    }
  }

  private transport(smtp: SmtpSettings) {
    return nodemailer.createTransport({
      host: smtp.host, port: smtp.port, secure: smtp.secure, requireTLS: this.config.smtp.requireTLS,
      auth: smtp.user ? { user: smtp.user, pass: smtp.password } : undefined,
      // Bounded so a host that drops packets fails an account request or a settings save promptly.
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    });
  }

  async send(message: { to: string; subject: string; text: string; html: string }): Promise<void> {
    const { smtp } = await this.settings();
    const transport = this.transport(smtp);
    try { await transport.sendMail({ from: smtp.from, ...message }); }
    finally { transport.close(); this.cached = undefined; }
  }

  /** False only when the provider reports remaining sends at or below the reserve; lookup failures admit the message. */
  async admit(): Promise<boolean> {
    const settings = await this.settings();
    const quota = await this.quota(settings.brevoApiKey);
    if (quota.status === 'unavailable') console.error(JSON.stringify({ component: 'mail', event: 'quota-unavailable', reason: quota.reason }));
    return quota.status !== 'available' || quota.remaining > settings.quotaReserve;
  }

  private quota(apiKey: string | undefined): Promise<Quota> {
    if (!apiKey) return Promise.resolve({ status: 'unconfigured' });
    if (this.cached?.apiKey === apiKey && Date.now() - this.cached.at < quotaTtl) return Promise.resolve(this.cached.quota);
    if (this.pending?.apiKey !== apiKey) {
      const promise = this.fetchQuota(apiKey).then((quota) => {
        this.cached = { apiKey, quota, at: Date.now() };
        return quota;
      }).finally(() => { if (this.pending?.promise === promise) this.pending = undefined; });
      this.pending = { apiKey, promise };
    }
    return this.pending.promise;
  }

  private async fetchQuota(apiKey: string): Promise<Quota> {
    let response: Response;
    try { response = await this.request(brevoAccount, { headers: { accept: 'application/json', 'api-key': apiKey }, signal: AbortSignal.timeout(5000) }); }
    catch { return { status: 'unavailable', reason: 'network' }; }
    if (!response.ok) return { status: 'unavailable', reason: `http-${response.status}` };
    const account = await response.json().catch(() => null) as { plan?: unknown; relay?: { enabled?: unknown } } | null;
    const plans = Array.isArray(account?.plan) ? account.plan.filter(isEmailPlan) : [];
    if (!plans.length) return { status: 'unavailable', reason: 'no-email-plan' };
    return {
      status: 'available', remaining: plans.reduce((total, plan) => total + plan.credits, 0),
      plans: plans.map(({ type, credits }) => ({ type, credits })), relayEnabled: account?.relay?.enabled === true,
      checkedAt: new Date().toISOString(),
    };
  }

  async status() {
    const settings = await this.settings();
    const [quota, audit] = await Promise.all([
      this.quota(settings.brevoApiKey),
      this.pool.query('SELECT actor_id,action,changed_fields,created_at FROM mail_settings_audit ORDER BY id DESC LIMIT 20'),
    ]);
    const { password, ...smtp } = settings.smtp;
    return {
      source: settings.source, storedUnreadable: settings.storedUnreadable, updatedAt: settings.updatedAt, updatedBy: settings.updatedBy,
      smtp: { ...smtp, user: smtp.user ?? '', passwordConfigured: !!password, requireTLS: this.config.smtp.requireTLS },
      quotaApiKeyConfigured: !!settings.brevoApiKey, quotaReserve: settings.quotaReserve, quota,
      audit: audit.rows.map((row) => ({ actorId: row.actor_id, action: row.action, changedFields: row.changed_fields, createdAt: row.created_at.toISOString() })),
    };
  }

  async update(actorId: string, input: MailUpdate) {
    const current = await this.settings();
    const smtp: SmtpSettings = {
      host: input.host, port: input.port, secure: input.secure, user: input.user || undefined,
      password: input.password === undefined ? current.smtp.password : input.password || undefined, from: input.from,
    };
    const apiKey = input.brevoApiKey === undefined ? current.brevoApiKey : input.brevoApiKey || undefined;
    const transport = this.transport(smtp);
    try { await transport.verify(); }
    catch (error) {
      const code = (error as { responseCode?: unknown }).responseCode;
      fail(422, 'MAIL_SMTP_REJECTED', `The SMTP server rejected these settings${typeof code === 'number' ? ` (${code})` : ''}`);
    } finally { transport.close(); }
    if (apiKey && apiKey !== current.brevoApiKey) {
      const quota = await this.fetchQuota(apiKey);
      if (quota.status !== 'available') fail(422, 'MAIL_QUOTA_KEY_REJECTED', `Brevo did not return an email quota for this API key (${quota.status === 'unavailable' ? quota.reason : quota.status})`);
    }
    const changed = Object.entries({
      host: smtp.host !== current.smtp.host, port: smtp.port !== current.smtp.port, secure: smtp.secure !== current.smtp.secure,
      user: smtp.user !== current.smtp.user, password: smtp.password !== current.smtp.password, from: smtp.from !== current.smtp.from,
      brevoApiKey: apiKey !== current.brevoApiKey, quotaReserve: input.quotaReserve !== current.quotaReserve,
    }).filter(([, differs]) => differs).map(([field]) => field);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO mail_settings (id,smtp_host,smtp_port,smtp_secure,smtp_user,smtp_password,smtp_from,brevo_api_key,quota_reserve,updated_by,updated_at)
        VALUES (true,$1,$2,$3,$4,$5,$6,$7,$8,$9,now())
        ON CONFLICT (id) DO UPDATE SET smtp_host=EXCLUDED.smtp_host,smtp_port=EXCLUDED.smtp_port,smtp_secure=EXCLUDED.smtp_secure,smtp_user=EXCLUDED.smtp_user,
          smtp_password=EXCLUDED.smtp_password,smtp_from=EXCLUDED.smtp_from,brevo_api_key=EXCLUDED.brevo_api_key,quota_reserve=EXCLUDED.quota_reserve,
          updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`, [
        smtp.host, smtp.port, smtp.secure, smtp.user ?? null, smtp.password ? this.seal(smtp.password, 'smtp_password') : null,
        smtp.from, apiKey ? this.seal(apiKey, 'brevo_api_key') : null, input.quotaReserve, actorId,
      ]);
      await client.query("INSERT INTO mail_settings_audit (actor_id,action,changed_fields) VALUES ($1,'update',$2)", [actorId, changed]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    this.cached = undefined;
    return this.status();
  }

  async reset(actorId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const removed = await client.query('DELETE FROM mail_settings RETURNING id');
      if (removed.rowCount) await client.query("INSERT INTO mail_settings_audit (actor_id,action,changed_fields) VALUES ($1,'reset','{}')", [actorId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    this.cached = undefined;
    return this.status();
  }
}
