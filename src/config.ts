import { isIP } from 'node:net';

export type ProductId = 'techmino' | 'techminoGalaxy';
export type ClientKind = 'native' | 'web';
export interface Product {
  id: ProductId;
  name: string;
  capabilities: string[];
  mobileRedirectUri: string;
  webRedirectUris: string[];
}
export interface ResourceKey {
  id: string;
  secret: string;
  products: ProductId[];
  validUntil?: number;
}
export interface Config {
  production: boolean;
  origin: string;
  hostname: string;
  port: number;
  databaseUrl: string;
  secret: string;
  origins: string[];
  adminIds: Set<string>;
  trustedProxyIps: Set<string>;
  products: Record<ProductId, Product>;
  resourceKeys: ResourceKey[];
  smtp: { host: string; port: number; secure: boolean; requireTLS: boolean; user?: string; password?: string; from: string };
}
function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing configuration: ${key}`);
  return value;
}
function integer(value: string | undefined, fallback: number, max: number): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new Error('Invalid numeric configuration');
  return parsed;
}
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const origin = new URL(required(env, 'PUBLIC_ORIGIN')).origin;
  if (production && !origin.startsWith('https://')) throw new Error('Production requires an HTTPS public origin');
  const secret = required(env, 'BETTER_AUTH_SECRET');
  if (secret.length < 32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters');
  const origins = (env.CORS_ORIGINS ?? origin).split(',').map((value) => new URL(value.trim()).origin);
  if (!origins.includes(origin)) origins.push(origin);
  const trustedProxyIps = new Set((env.TRUSTED_PROXY_IPS ?? '').split(',').filter(Boolean));
  if ([...trustedProxyIps].some((value) => !isIP(value))) throw new Error('Trusted proxies must be explicit IP addresses');
  const callback = `${origin}/account/product-callback`;
  const products: Record<ProductId, Product> = {
    techmino: {
      id: 'techmino', name: 'Techmino', capabilities: ['connect', 'cloud'],
      mobileRedirectUri: 'org.studio26f.techmino:/callback',
      webRedirectUris: [callback, ...(env.TECHMINO_WEB_CALLBACKS ?? `${origin}/play/techmino/`).split(',')],
    },
    techminoGalaxy: {
      id: 'techminoGalaxy', name: 'Techmino Galaxy', capabilities: ['connect'],
      mobileRedirectUri: 'org.studio26f.techmino-galaxy:/callback',
      webRedirectUris: [callback, ...(env.GALAXY_WEB_CALLBACKS ?? `${origin}/play/techmino-galaxy/`).split(',')],
    },
  };
  for (const product of Object.values(products)) {
    for (const uri of product.webRedirectUris) {
      const url = new URL(uri);
      if (!origins.includes(url.origin) || url.username || url.password || url.hash || url.search) throw new Error('Web callbacks require an approved exact origin and path');
    }
  }
  const entries: unknown = JSON.parse(required(env, 'RESOURCE_KEYS'));
  if (!Array.isArray(entries) || !entries.length || entries.length > 4) throw new Error('RESOURCE_KEYS requires 1–4 configured credentials');
  const resourceKeys: ResourceKey[] = entries.map((entry: unknown, index: number) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid resource credential');
    const item = entry as Record<string, unknown>;
    if (typeof item.id !== 'string' || typeof item.secret !== 'string' || item.secret.length < 32 || !Array.isArray(item.products) || !item.products.length) throw new Error('Invalid resource credential');
    if (!item.products.every((id: unknown) => typeof id === 'string' && Object.hasOwn(products, id))) throw new Error('Unregistered resource product');
    const validUntil = item.validUntil === undefined ? undefined : Date.parse(String(item.validUntil));
    if (validUntil !== undefined && (!Number.isFinite(validUntil) || validUntil > Date.now() + 300000)) throw new Error('Resource rotation overlap must expire within five minutes');
    if (index > 0 && validUntil === undefined) throw new Error('Old resource credentials require a bounded overlap expiry');
    return { id: item.id, secret: item.secret, products: item.products as ProductId[], validUntil };
  });
  const smtpSecure = env.SMTP_SECURE === 'true';
  const smtpRequireTLS = production || env.SMTP_REQUIRE_TLS === 'true';
  return {
    production, origin, hostname: env.HOST ?? '127.0.0.1', port: integer(env.PORT, 17436, 65535),
    databaseUrl: required(env, 'DATABASE_URL'), secret, origins, trustedProxyIps,
    adminIds: new Set((env.ACCOUNT_ADMIN_IDS ?? '').split(',').filter(Boolean)), products, resourceKeys,
    smtp: {
      host: required(env, 'SMTP_HOST'), port: integer(env.SMTP_PORT, smtpSecure ? 465 : 587, 65535),
      secure: smtpSecure, requireTLS: smtpRequireTLS,
      user: env.SMTP_USER, password: env.SMTP_PASSWORD,
      from: required(env, 'SMTP_FROM'),
    },
  };
}
