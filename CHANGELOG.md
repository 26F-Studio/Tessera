# Changelog

## Unreleased

- Added administrator-editable mail delivery settings (`/v1/admin/mail`, migration 3): SMTP login is verified before saving, secrets are sealed at rest, and changes are audited by field name.
- Added Brevo quota lookup: mail-sending account endpoints return `429 MAIL_DAILY_LIMIT_REACHED` once the remaining daily sends reach the configured reserve; lookup failures still send.
- A repeated sign-up for an unverified email keeps the generic response and mails a "finish creating your account" password link; completing it verifies the account and replaces any password chosen by an earlier registrant. Verified emails still receive nothing.
- Account emails (verification, password reset, account completion, email change, sign-in codes) are sent as HTML with a button and a plain-text alternative.

## 0.1.0 — First-party account and product sessions

- Introduced real Better Auth account registration, verified email, password/email-OTP sign-in, recovery, browser-session management, and protected profile/avatar operations.
- Replaced the evaluated OAuth Provider candidate with independent first-party Techmino/Galaxy device grants, S256 PKCE handoff, opaque product access, native refresh rotation, and separate HttpOnly web product sessions.
- Implemented account/product credential isolation, withdrawal, native logout, all-device logout, password-reset revocation, and disable without deleting game data.
- Added separate account-library/product migrations and non-administrative runtime startup requirements.
- Added authorization-reset fencing for delayed browser decisions and explicit controlled-proxy client-IP handling.
- Passed five actual PostgreSQL concurrency/boundary regressions and the nine account lifecycle scenarios over certificate-verified local HTTPS.
- Exercised the account/product lifecycle with PostgreSQL, SMTP, and a real Elysia listener. Integrated game/platform/deployment acceptance is tracked separately and is not implied by this account release entry.
- Exercised actual resource-credential fallback, a bounded current/previous overlap and previous-credential expiry against real local Tessera/Cadence; retained only the new current credential afterward.
- Included Cadence's SQLx bookkeeping table in full-database restore verification. Completed a drained isolated restore with exact row, replay-digest, least-privilege and restored-runtime checks; production migration remains separate.
- Replaced the automatically removed local PostgreSQL feasibility probe with an explicitly approved named-volume acceptance cluster. Recovered the verified database backup without overwriting existing databases or changing protected application credentials; post-backup test state was not recovered.
- Filter the proxy's default runtime error logger, not only an access logger: remove complete request URI, headers and client addresses while preserving method/status/error/time. Verify the actual Caddy deployment configuration over trusted TLS with noncredential failure markers and activate the same filter in the isolated fixture.
