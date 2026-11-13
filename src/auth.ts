import { randomUUID } from 'node:crypto';
import { betterAuth, type Auth, type BetterAuthOptions } from 'better-auth';
import { APIError, createAuthMiddleware, getAuthoritativeSessionFromCtx } from 'better-auth/api';
import { emailOTP } from 'better-auth/plugins';
import type { Authorization } from './authorization';
import type { Config } from './config';
import type { Mailer } from './mail';
import { codeMail, emailChangeMail, finishAccountMail, passwordResetMail, verificationMail } from './mail-templates';

const guardedSessionPaths: Record<string, true> = {
  '/get-session': true, '/update-user': true, '/change-password': true,
  '/change-email': true, '/list-sessions': true, '/set-password': true,
};
// Endpoints that may send a message; they are refused before any account
// state changes once the provider quota is exhausted.
const mailPaths: Record<string, true> = {
  '/sign-up/email': true, '/send-verification-email': true, '/request-password-reset': true,
  '/change-email': true, '/email-otp/send-verification-otp': true, '/email-otp/request-password-reset': true,
};

export function createAccountAuth(config: Config, authorization: Authorization, mail: Mailer) {
  const options = {
    appName: '26F Studio', baseURL: config.origin, basePath: '/api/auth',
    secret: config.secret, database: authorization.pool, trustedOrigins: config.origins,
    advanced: {
      database: { generateId: () => randomUUID() },
      useSecureCookies: config.origin.startsWith('https://'),
      ipAddress: { ipAddressHeaders: ['x-tessera-client-ip'] },
    },
    emailAndPassword: {
      enabled: true, requireEmailVerification: true, minPasswordLength: 8, maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        await mail.send({ to: user.email, ...(user.emailVerified ? passwordResetMail(url) : finishAccountMail(url)) });
      },
      onPasswordReset: async ({ user }) => {
        // Completing a mailed reset proves mailbox ownership, so it also verifies
        // an account whose original verification never arrived.
        if (!user.emailVerified) await authorization.pool.query('UPDATE "user" SET "emailVerified"=true, "updatedAt"=now() WHERE id=$1', [user.id]);
        await authorization.revokeUser(user.id, undefined, false, true);
      },
      // A repeated sign-up keeps the generic response. Its password is discarded,
      // so an unverified owner gets a reset link: verifying the existing account
      // directly would activate a password someone else may have chosen.
      onExistingUserSignUp: async ({ user }) => {
        if (user.emailVerified) return;
        await auth.api.requestPasswordReset({ body: { email: user.email, redirectTo: `${config.origin}/account/reset-password` } });
      },
    },
    emailVerification: {
      sendOnSignUp: true, autoSignInAfterVerification: false, expiresIn: 1800,
      sendVerificationEmail: async ({ user, url }) => { await mail.send({ to: user.email, ...verificationMail(url) }); },
    },
    user: {
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: async ({ user, newEmail, url }) => { await mail.send({ to: user.email, ...emailChangeMail(url, newEmail) }); },
      },
    },
    session: { expiresIn: 604800, freshAge: 600, cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 300 },
    plugins: [emailOTP({
      otpLength: 8, expiresIn: 300, allowedAttempts: 5, disableSignUp: true, storeOTP: 'hashed',
      sendVerificationOTP: async ({ email, otp, type }) => { await mail.send({ to: email, ...codeMail(otp, type) }); },
    })],
    databaseHooks: {
      user: { create: { after: async (user) => { await authorization.createAccountState(user.id); } } },
      session: { create: { before: async (session) => {
        if (!await authorization.accountEnabled(session.userId)) throw new APIError('FORBIDDEN', { message: 'Account disabled' });
      } } },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/sign-up/email' || ctx.path === '/update-user') {
          const name = ctx.body?.name;
          if (name !== undefined && (typeof name !== 'string' || name.trim().length < 2 || name.length > 32 || /[\u0000-\u001f\u007f]/.test(name))) throw new APIError('BAD_REQUEST', { message: 'Name must contain 2–32 visible characters' });
        }
        if (guardedSessionPaths[ctx.path]) {
          const session = await getAuthoritativeSessionFromCtx(ctx);
          if (session && !await authorization.accountEnabled(session.user.id)) throw new APIError('FORBIDDEN', { message: 'Account disabled' });
        }
        if (mailPaths[ctx.path] && !await mail.admit()) {
          throw APIError.from('TOO_MANY_REQUESTS', { code: 'MAIL_DAILY_LIMIT_REACHED', message: "Today's email sending limit has been reached. Please try again tomorrow." });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === '/change-password' && !(ctx.context.returned instanceof APIError)) {
          const subject = ctx.context.session?.user.id;
          if (subject) await authorization.revokeUser(subject);
        }
      }),
    },
    logger: {
      level: 'error',
      log: (level) => { console.error(JSON.stringify({ component: 'account', level, event: 'operation-failed' })); },
    },
  } satisfies BetterAuthOptions;
  const auth = betterAuth(options);
  return { auth, options };
}
export type AccountAuth = Auth<BetterAuthOptions>;
