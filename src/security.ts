import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}
export function fail(status: number, code: string, message: string): never { throw new HttpError(status, code, message); }
export function secretToken(prefix: 'ta' | 'tr' | 'tc'): string { return `${prefix}_${randomBytes(32).toString('base64url')}`; }
export function tokenHash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
export function equalSecret(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(tokenHash(left), 'hex'), Buffer.from(tokenHash(right), 'hex'));
}
export function pkceChallenge(verifier: string): string {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) fail(400, 'INVALID_PROOF', 'Invalid authorization proof');
  return createHash('sha256').update(verifier).digest('base64url');
}
export function accessBearer(headers: Headers): string {
  const value = headers.get('authorization');
  if (!value?.startsWith('Bearer ')) fail(401, 'AUTHENTICATION_REQUIRED', 'Authentication required');
  const token = value.slice(7);
  if (token.length > 256) fail(401, 'INVALID_CREDENTIAL', 'Invalid credential');
  return token;
}
export function tokenLooksValid(value: unknown, kind: 'ta' | 'tr' | 'tc'): value is string {
  return typeof value === 'string' && new RegExp(`^${kind}_[A-Za-z0-9_-]{43}$`).test(value);
}
export class RateBudget {
  private readonly windows = new Map<string, { start: number; used: number }>();
  take(key: string, limit: number, now = Date.now()): void {
    const current = this.windows.get(key);
    if (current && now - current.start < 60_000) {
      if (current.used >= limit) fail(429, 'RATE_LIMITED', 'Request rate exceeded');
      current.used++;
      return;
    }
    if (this.windows.size >= 4096) {
      for (const [id, value] of this.windows) if (now - value.start >= 60_000) this.windows.delete(id);
      if (this.windows.size >= 4096) fail(503, 'ADMISSION_BUSY', 'Request capacity exhausted');
    }
    this.windows.set(key, { start: now, used: 1 });
  }
}
