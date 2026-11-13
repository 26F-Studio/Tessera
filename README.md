# Tessera

**English** | [简体中文](README.zh-CN.md)

First-party account and product-session service for Techmino and Techmino Galaxy. This service **is not an OAuth/OIDC provider**. Better Auth owns account credentials, email verification/recovery, and browser sessions. Tessera owns independent product/device grants and opaque product access credentials.

## Requirements and startup

- Bun 1.4.2; pinned dependencies in `bun.lock`.
- PostgreSQL 18 or a compatible tested deployment.
- An actual SMTP service. Production requires verified TLS; local Mailpit is a fixture, not a mail-delivery claim.
- A same-origin HTTPS reverse proxy serving the account website, `/api/auth/*`, and `/v1/*`. Bind the service only to an internal network or loopback.

Copy `.env.example` to a protected, ignored environment file. Generate unique account and resource secrets; never commit them. Use a schema-owning migration role through `MIGRATION_DATABASE_URL` and a separate DML-only runtime role through `DATABASE_URL`.

```sh
bun install --frozen-lockfile
bun run migrate
bun run typecheck
bun run start
```

Startup refuses PostgreSQL superuser/createdb/createrole privileges. The migration command uses Better Auth's actual migration API, then the ordered owned product/profile and authorization-reset migrations. Runtime requires schema version 2 and never runs DDL. Grant the runtime role SELECT/INSERT/UPDATE/DELETE on the actual application tables and USAGE on the owned schema/sequences; it must not own the database. Cadence must use a different database/role and cannot read Tessera credentials or sessions.

`GET /health/live` reports process liveness. `GET /health/ready` performs a real database query. SIGTERM/SIGINT stops new operations, closes the listener and pool, and does not write credentials to logs.

## Account and product boundaries

Account API: `/api/auth/*`, with required email verification, password and email OTP sign-in, recovery, email/password changes, and browser-session management. Passwords are 8–128 characters and are never prehashed by the browser. Only the supported account endpoints are exposed; social/OAuth/admin-plugin endpoints are not implicitly enabled.

Sign-up never reveals whether an email is registered. A repeated sign-up for an unverified email discards the submitted password and mails a single-use "finish creating your account" password link; completing that reset verifies the account and replaces any password an earlier registrant chose. A repeated sign-up for a verified email sends nothing.

Public profiles expose only identity/name/motto/region and validated avatars. Private account profile data requires an account browser session. Avatar upload accepts bounded PNG/JPEG/WebP, decodes it, rejects animation/oversized dimensions, and re-encodes PNG before public delivery. The maximum upload is 256 KiB and 512×512 pixels.

Product authorization starts at `POST /v1/authorization/requests`, approved or denied by the account website. S256 PKCE, registered callback/product/state, request and code expiry, and atomic single-use exchange bind the handoff. There is no embedded native secret and no account/game token concatenation. Access tokens are random opaque credentials, expire after 300 seconds, and identify exactly one independent grant/product.

Native refresh credentials rotate on successful use and expire after 30 days without sliding extension. The immediate previous refresh replay revokes that device grant; unknown/older credentials cannot extend it. Each product permits at most five active device grants per user. Access issuance retains at most 32 live credentials per grant so early renewal does not invalidate a still-admitted socket before it switches credentials.

Web uses an independent stable HttpOnly product-session cookie, scoped to `/v1/products/<id>/session`, not a JavaScript-readable refresh token. This avoids legitimate game/website/tab refresh races. Product access remains memory-only. Do not forward account or product-refresh cookies to Cadence; use separate host-only cookies or strip Cookie at the game reverse-proxy boundary.

| Operation | Effect |
| --- | --- |
| Browser sign-out | Browser session ends; independent game grants survive |
| Native product logout | That device grant and all of its access credentials end |
| Product withdrawal | All own grants for the selected product end |
| Account all-device logout | All browser sessions and all product grants end |
| Successful password reset/change | All product grants end; reset also revokes browser sessions |
| Account deactivate/disable | Reject login/issuance/refresh/validation for every product; preserve profile and game data |

Account all-device logout is `/v1/account/logout-all`; Better Auth's browser-only `revoke-sessions` is deliberately not an alias for this operation. Deactivation requires an account session created within ten minutes. Account administrator IDs are operator configuration, not profile-writable permissions; room ownership and Cadence game administration are separate.
All-device logout and password reset also fence delayed authorization decisions from previously created browser sessions. An old in-flight positive session result cannot approve a new grant after that reset. Controlled proxy IPs are explicit `TRUSTED_PROXY_IPS`; only those peers may supply the sanitized `X-Real-IP`. Account-library IP headers are replaced by the service's own trusted value.

Mail delivery starts from the `SMTP_*` environment values. Account administrators can override them at `GET`/`PUT`/`DELETE /v1/admin/mail` (the account page shows the panel); a write requires an account session created within ten minutes, verifies the SMTP login before saving, and records the changed field names, never values, in `mail_settings_audit`. Saved SMTP passwords and the optional Brevo API key are sealed with AES-256-GCM under a key derived from `BETTER_AUTH_SECRET`; after rotating that secret the saved row is ignored until it is saved again. With a Brevo API key (restricted to Account read), Tessera reads the remaining email sends from `GET https://api.brevo.com/v3/account` and refuses sign-up, verification, password-reset, email-change and email-code requests with `429 MAIL_DAILY_LIMIT_REACHED` once the remaining count is at or below the configured reserve, before any account state changes. Brevo queues rather than rejects SMTP mail over the daily limit, so this pre-check is the only refusal point. A failed quota lookup admits the message and logs `quota-unavailable`.


## Cadence validation

`POST /v1/internal/authorizations/validate` accepts a configured resource-server Bearer secret and `{productId, accessToken}`. It checks the actual access expiry, grant status/product, verified enabled account, and caller's allowed products. Active replies contain only trusted identity/capabilities and `validatedAt`/`expiresAt`, never refresh credentials. Native clients do not receive resource-server secrets.

The resource budget is 6,000 requests per minute per registered resource key; Cadence must still bound concurrency and enforce its five-second freshness/outage deadline. This is current-state validation, not a forever-valid identity assertion.

Secret rotation supports a new primary key plus a bounded old-key overlap of at most five minutes. Old keys require explicit `validUntil`; expired overlap cannot authenticate. Fixed configured endpoints are trusted, not a credential-supplied issuer/key URL.

## Verified scope

A real isolated PostgreSQL, actual Mailpit SMTP inbox, and the actual Elysia listener behind a certificate-verified local HTTPS proxy were used to exercise registration/verification, decoded profile/avatar, PKCE single-use exchange and account/product isolation, native browser-logout independence, refresh overlap/replay, product withdrawal, all-device logout across both products, password reset, web-cookie independence/logout, and self-disable. TypeScript checking passed. Five real PostgreSQL concurrency/boundary tests passed, including one-use exchange, proof binding, cancellation/expiry, concurrent native refresh replay revocation, and delayed-session authorization fencing.

Run the isolated database/SMTP integration suite with an explicit fixture environment:

```sh
TESSERA_INTEGRATION=true bun --env-file=.env.test test test/authorization.integration.test.ts
```

It refuses a production or non-loopback issuer. Its SMTP inspection requires a real Mailpit fixture at `http://127.0.0.1:18025`; it never creates a verified identity by editing account tables.

These account measurements do **not** prove Cadence WSS revocation deadlines, actual game behavior, load limits, browser rendering/PWA update, or unexecuted platform packages. Those require the integrated release acceptance and real-device results in the implementation plan.
