import { getMigrations } from 'better-auth/db/migration';
import { Pool } from 'pg';
import { Authorization } from './authorization';
import { createAccountAuth } from './auth';
import { loadConfig } from './config';
import { Mailer } from './mail';

const config = loadConfig();
const pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL ?? config.databaseUrl, max: 2 });
try {
  const authorization = new Authorization(pool, config);
  const { options } = createAccountAuth(config, authorization, new Mailer(pool, config));
  const owner = await pool.connect();
  try {
    await owner.query('SELECT pg_advisory_lock(742615125)');
    const migrations = await getMigrations(options);
    await migrations.runMigrations();
    await owner.query(await Bun.file(new URL('../migrations/001_product_sessions.sql', import.meta.url)).text());
    await owner.query(await Bun.file(new URL('../migrations/002_authorization_reset.sql', import.meta.url)).text());
    await owner.query(await Bun.file(new URL('../migrations/003_mail_settings.sql', import.meta.url)).text());
    console.log('Tessera account and product migrations applied');
  } finally {
    await owner.query('SELECT pg_advisory_unlock(742615125)');
    owner.release();
  }
} finally { await pool.end(); }
