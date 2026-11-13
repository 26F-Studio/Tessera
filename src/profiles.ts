import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import sharp from 'sharp';
import type { Config } from './config';
import { fail } from './security';

sharp.concurrency(1);
export class Profiles {
  constructor(private readonly pool: Pool, private readonly config: Config) {}

  async get(userId: string, privateProfile = false) {
    const { rows } = await this.pool.query(
      'SELECT u.id,u.name,u.email,u."emailVerified",COALESCE(p.motto,\'\') AS motto,COALESCE(p.region,\'\') AS region,p.avatar_version AS "avatarVersion" FROM "user" u LEFT JOIN profiles p ON p.user_id=u.id WHERE u.id=$1', [userId],
    );
    const row = rows[0];
    if (!row) fail(404, 'PROFILE_NOT_FOUND', 'Profile not found');
    const profile = {
      id: row.id as string, name: row.name as string, motto: row.motto as string, region: row.region as string,
      avatarVersion: row.avatarVersion as string | null,
      avatarUrl: row.avatarVersion ? `${this.config.origin}/v1/profiles/${encodeURIComponent(userId)}/avatar?v=${row.avatarVersion}` : null,
    };
    return privateProfile ? { ...profile, email: row.email, emailVerified: row.emailVerified, isAccountAdmin: this.config.adminIds.has(userId) } : profile;
  }

  async update(userId: string, input: { motto?: string; region?: string }): Promise<void> {
    if (input.motto !== undefined && (input.motto.length > 150 || /[\u0000-\u001f\u007f]/.test(input.motto))) fail(400, 'INVALID_PROFILE', 'Motto must contain at most 150 visible characters');
    if (input.region !== undefined && !/^([A-Z]{2})?$/.test(input.region)) fail(400, 'INVALID_PROFILE', 'Region must be an ISO alpha-2 code or empty');
    await this.pool.query(
      'INSERT INTO profiles (user_id,motto,region) VALUES ($1,COALESCE($2,\'\'),COALESCE($3,\'\')) ON CONFLICT (user_id) DO UPDATE SET motto=COALESCE($2,profiles.motto),region=COALESCE($3,profiles.region)',
      [userId, input.motto ?? null, input.region ?? null],
    );
  }

  async setAvatar(userId: string, bytes: Uint8Array): Promise<void> {
    if (bytes.length > 262144 || bytes.length < 12) fail(413, 'AVATAR_LIMIT', 'Avatar must be at most 256 KiB');
    const source = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const png = source.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = source[0] === 255 && source[1] === 216;
    const webp = source.toString('ascii', 0, 4) === 'RIFF' && source.toString('ascii', 8, 12) === 'WEBP';
    if (!png && !jpeg && !webp) fail(415, 'INVALID_AVATAR', 'Only decoded PNG, JPEG, or WebP images are supported');
    let image: Buffer;
    try {
      const decoder = sharp(source, { limitInputPixels: 262144, failOn: 'warning', animated: false });
      const metadata = await decoder.metadata();
      if (!metadata.width || !metadata.height || metadata.width > 512 || metadata.height > 512 || (metadata.pages ?? 1) > 1) fail(413, 'AVATAR_LIMIT', 'Avatar dimensions must not exceed 512×512');
      image = await decoder.rotate().png().toBuffer();
    } catch (error) {
      if (error instanceof Error && error.name === 'HttpError') throw error;
      fail(400, 'INVALID_AVATAR', 'Avatar image cannot be decoded');
    }
    if (image.length > 262144) fail(413, 'AVATAR_LIMIT', 'Decoded avatar must be at most 256 KiB');
    await this.pool.query('INSERT INTO profiles (user_id,avatar,avatar_version) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET avatar=EXCLUDED.avatar,avatar_version=EXCLUDED.avatar_version', [userId, image, randomUUID()]);
  }

  async avatar(userId: string, etag: string | null): Promise<Response> {
    const { rows } = await this.pool.query('SELECT avatar,avatar_version FROM profiles WHERE user_id=$1 AND avatar IS NOT NULL', [userId]);
    if (!rows[0]) fail(404, 'AVATAR_NOT_FOUND', 'Avatar not found');
    const version = `"${rows[0].avatar_version}"`;
    const headers = { 'Content-Type': 'image/png', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=300', ETag: version };
    return new Response(etag === version ? null : rows[0].avatar, { status: etag === version ? 304 : 200, headers });
  }
}
