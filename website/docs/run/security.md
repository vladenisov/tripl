---
title: Security & Hardening
sidebar_position: 6
---

# Security & Hardening

This page is for operators and security reviewers running a self-hosted tripl instance. It documents what the application enforces today, the two secrets you must manage, how to rotate each one (and what breaks when you do), and a pre-production hardening checklist.

Everything below is verified against the code. Where the platform relies on you (TLS termination, reverse proxy, network isolation), that is called out explicitly.

:::note
tripl does not terminate TLS itself. It is an HTTP application meant to run behind a reverse proxy or load balancer that handles HTTPS. The security posture below assumes that proxy exists — several settings (HSTS, secure cookies, trusting proxy IP headers) are unsafe without it. See [Self-hosting & Deployment](./deployment.md).
:::

## The two secrets

tripl has two independent application secrets. They protect different things, rotate differently, and have very different blast radii. Do not reuse one value for both.

| Setting | Env var | Algorithm | Protects | Rotation impact |
|---|---|---|---|---|
| Encryption key | `ENCRYPTION_KEY` | Fernet (AES-128-CBC + HMAC-SHA256) | At-rest third-party secrets: warehouse passwords, alert-destination secrets, AI/SMTP secrets stored in instance settings | Existing ciphertext can no longer be decrypted — stored secrets must be re-entered |
| Session signing key | `SECRET_KEY` | HMAC-SHA256 | Integrity of session-token lookups in the DB | All sessions invalidated — every user is logged out and must log in once |

Both default to an empty string, and in a non-debug deploy an empty value (or, for `ENCRYPTION_KEY`, an invalid one) **refuses startup** — see [Production startup checks](#production-startup-checks).

### `ENCRYPTION_KEY` — encryption of at-rest secrets

`backend/src/tripl/crypto.py` centralizes a Fernet-based `encrypt_value` / `decrypt_value` pair. Every service that persists a third-party credential runs the value through it before writing the column:

- **Warehouse/data-source passwords** — `datasource_service.py` stores `password_encrypted`; the value is decrypted when the connection is used.
- **Alert-destination secrets** — `_alerting_destinations.py` encrypts the secret on write; the alert worker decrypts it at send time.
- **Instance-settings secrets** — `app_settings_service.py` encrypts the fields `ai_api_key`, `search_embedding_api_key`, and `smtp_password` when they are set through the admin settings UI.

Behavior of the Fernet layer:

- With a configured key, values round-trip through Fernet.
- With an **empty** key **and** `DEBUG=true`, values are stored as-is (plaintext) so local dev/test runs work without provisioning a key.
- With an empty key in production, startup is blocked — so the plaintext fall-through can only ever execute in dev/test.
- `decrypt_value` raises `InvalidToken` when a key is set but the ciphertext is corrupt or was written under a different key. Callers surface that as a connection/send error to the operator rather than crashing.

Generate a key with:

```bash
python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
```

### `SECRET_KEY` — session-token signing

Login issues a random session token (`secrets.token_urlsafe(32)`) and sets it as the session cookie. The **token itself is never stored** — only its HMAC-SHA256 digest, keyed by `SECRET_KEY`, lands in the `user_sessions` table (`auth_utils.hash_session_token`). On each request the cookie value is re-hashed with the same key and looked up.

Keying the hash with `SECRET_KEY` (instead of a bare SHA-256) means a leaked session-hash column is useless without the secret, and tokens cannot be precomputed or rainbow-tabled.

Generate a key with:

```bash
python -c 'import secrets; print(secrets.token_urlsafe(32))'
```

:::warning
API keys are **not** keyed by `SECRET_KEY`. They are stored as a plain SHA-256 of the raw token (`api_key_service.py`). Rotating `SECRET_KEY` therefore logs out interactive (cookie) users but leaves issued API keys working. Rotating `ENCRYPTION_KEY` affects neither sessions nor API keys — only encrypted at-rest secrets.
:::

## Rotating the secrets

### Rotating `SECRET_KEY`

1. Generate a new value (command above).
2. Set `SECRET_KEY` in the environment and restart the API and worker.
3. Every existing session-token hash was computed with the old key, so every lookup now misses. **All users are logged out and must log in once.** No data is lost; new logins immediately work.

Stale session rows are harmless — they no longer match any cookie and are cleaned up lazily as they expire (`SESSION_TTL_HOURS`, default 168h / 7 days), or whenever the owning user next logs in.

### Rotating `ENCRYPTION_KEY`

There is **no automated re-encryption tool** and the current implementation uses a single Fernet key (not `MultiFernet`), so there is no rolling/overlap window. Rotation is therefore a deliberate, operator-driven re-entry:

1. Before rotating, make sure you can re-supply every stored secret: each data-source password, each alert-destination secret, and the instance settings `ai_api_key`, `search_embedding_api_key`, and `smtp_password`.
2. Set the new `ENCRYPTION_KEY` and restart the API and worker. (The Fernet instance is cached per process via `lru_cache`, so a restart is required for the new key to take effect.)
3. Every secret encrypted under the old key now fails to decrypt with `InvalidToken`. Re-enter each one through the UI so it is re-encrypted under the new key. Until you do, warehouse connections, alert sends, and the affected AI/SMTP features will error.

:::danger
If you lose `ENCRYPTION_KEY` and have no backup, the encrypted secrets are unrecoverable. They must be re-entered from their original sources. Back up this key separately from the database.
:::

## Production startup checks

`Settings.assert_production_ready()` (in `backend/src/tripl/config.py`) runs from the FastAPI lifespan on startup. When `DEBUG=false` it collects every problem and raises `RuntimeError` (refusing to boot) if any of the following hold. It is a no-op when `DEBUG=true`, and it does **not** run for tests or CLI tools that import `Settings` directly.

| Check | Failure condition |
|---|---|
| `ENCRYPTION_KEY` present | Empty → secrets would be stored as plaintext |
| `ENCRYPTION_KEY` valid | Set but not a valid Fernet key |
| `SECRET_KEY` present | Empty → session hashes would be unkeyed/guessable |
| `SESSION_COOKIE_SECURE` | `false` → cookies would be sent over plain HTTP |
| CORS origins resolved | Empty → no browser can call the API |
| CORS not wildcard | Resolves to `*` → credentialed cookie requests break |
| No dev DB/broker creds | `DATABASE_URL`, `SYNC_DATABASE_URL`, or `RABBITMQ_URL` still contain the dev-default credentials `tripl:tripl` / `guest:guest` |

This is a fail-fast guard, not a substitute for the full checklist below. It only inspects configuration values; it cannot verify your TLS, network, or proxy setup.

`DEBUG` is normalized: the strings `release` / `prod` / `production` map to `DEBUG=false`, and `dev` / `development` map to `DEBUG=true`.

## TLS, HSTS, and security headers

`SecurityHeadersMiddleware` (`backend/src/tripl/middleware/security_headers.py`) is added when `SECURITY_HEADERS_ENABLED=true` (the default). It appends the headers below to **every** response, including error responses, and never overrides a header a downstream handler already set.

Always applied:

- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()`

Conditional:

- **Content-Security-Policy** — emitted only if `CONTENT_SECURITY_POLICY` is set, *or* if `SERVE_FRONTEND=true` and no explicit policy is given (then a SPA-tuned default is applied):

  ```
  default-src 'self'; script-src 'self';
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  img-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com;
  connect-src 'self';
  frame-ancestors 'none'; base-uri 'self'; form-action 'self'
  ```

  If you do not serve the SPA from the API and you do not set `CONTENT_SECURITY_POLICY`, **no CSP header is emitted** — set one at your proxy or via the env var.

- **HSTS** — emitted only when `HSTS_ENABLED=true`, as `Strict-Transport-Security: max-age=<HSTS_MAX_AGE_SECONDS>; includeSubDomains` (default max-age 31536000, one year). HSTS is opt-in by design: enabling it without HTTPS in front would make the site unreachable over HTTP with no way back. Turn it on only once TLS and `SESSION_COOKIE_SECURE=true` are in place.

:::tip
The `'unsafe-inline'` in `style-src` is required by the bundled UI
(Radix/Tailwind/recharts/CodeMirror inline styles). The two Google origins are
limited to the stylesheet and font files used by the bundled page; scripts
remain `'self'` only, including the external pre-React theme initializer. If
you tighten the CSP, test the SPA before shipping it.
:::

The middleware reads `CONTENT_SECURITY_POLICY`, `SERVE_FRONTEND`, `HSTS_ENABLED`, and `HSTS_MAX_AGE_SECONDS` **once at construction time**. Changing any of them requires an API restart to take effect.

## Rate limiting

`backend/src/tripl/middleware/rate_limit.py` provides an in-process token-bucket limiter wired as a FastAPI dependency on the two unauthenticated auth endpoints:

| Route | Setting | Default |
|---|---|---|
| `POST /api/v1/auth/login` | `RATE_LIMIT_LOGIN_PER_MINUTE` | 5 / minute |
| `POST /api/v1/auth/register` | `RATE_LIMIT_REGISTER_PER_HOUR` | 3 / hour |
| `POST /api/v1/auth/password-reset/request` | `RATE_LIMIT_LOGIN_PER_MINUTE` | 5 / minute |
| `POST /api/v1/auth/password-reset/confirm` | `RATE_LIMIT_LOGIN_PER_MINUTE` | 5 / minute |

The two password-reset routes reuse the **login** limiter (same bucket and
setting), so they share its per-IP quota. Buckets are keyed per
`(limiter name, client-IP)`, so routes on **different** limiters (login vs
register) do not share quota, while routes that reuse a limiter (the password-reset
routes on the login limiter) do. Exceeding a limit returns `429 Too Many Requests`
with a `Retry-After` header. To turn rate limiting off entirely, set
`RATE_LIMIT_ENABLED=false`.

Set an individual route's limit to `0` to disable that route limiter while
leaving the other one active. Use `RATE_LIMIT_ENABLED=false` to disable both.

**Client-IP source — read this before exposing the API directly.** By default the limiter keys on the real socket peer (`request.client.host`), which is correct when the API is the edge (including the single-container `SERVE_FRONTEND` deploy). `RATE_LIMIT_TRUST_FORWARDED_FOR` defaults to **false** on purpose: a raw `X-Forwarded-For` is attacker-controlled, so trusting it on a directly-exposed API lets an unauthenticated caller rotate the header per request and bypass the limit entirely. Enable it **only** behind a trusted proxy that *overwrites* `X-Real-IP` with the true client address on every request (the shipped nginx config does this). When enabled the limiter prefers `X-Real-IP`, falling back to the leftmost `X-Forwarded-For` entry.

:::warning
The limiter is **per worker, in memory**. With multiple Uvicorn/Gunicorn workers or replicas, each holds its own buckets, so the effective limit is roughly the configured value times the worker count. For a hard aggregate cap, enforce rate limiting at the proxy/LB tier as well.
:::

## Authentication, sessions, and cookies

### Self-service registration

`POST /api/v1/auth/register` is the only unauthenticated way to obtain an
account, and it is governed by a single instance setting, `REGISTRATION_MODE`
(`Settings → Instance → Security & access → Registration`):

| Mode | Behaviour |
|---|---|
| `open` (**default**) | Anyone who can reach the instance can create an account (rate-limited). |
| `disabled` | New signups are refused with `403`. |

:::danger Read this before you expose an instance publicly
**The default is `open`, and `open` means anyone who can reach the URL can
create an account.** A new account joins as **editor** — not as a read-only
viewer — so a stranger who registers can immediately **read**:

- the workspace's **entire tracking plan** — every project, event, variable,
  metric and annotation;
- the **member roster** (`GET /api/v1/users`: names, emails, roles);
- each data source's **name, database type and health status** — enough to tell
  which warehouse a scan or metric points at. Connection details (host, port,
  username, whether a password is set, TLS settings) are owner-only and redacted
  from everyone else, and the password itself is never returned to anybody.
  Reading the warehouse's **table and column names**
  (`GET /api/v1/data-sources/{id}/schema`) stops at **editor**, because the scan,
  metric and fact-table forms drive their column pickers off it; a **viewer**
  gets `403`. `/stats` is owner-only.

…and **write**:

- create, rename and edit **any shared project** — the tracking plan an owner
  created, and any project predating creator tracking — including its events,
  event types, variables and scan configuration.

Another member's **demo workspace** and a project created by a **different
editor** stay closed, and deleting a project or creating/editing a data source
remains owner-only. See [Roles and access control](#roles-and-access-control-rbac).

If your instance is reachable from the internet, decide the policy **before**
the first deploy, not after. Setting `REGISTRATION_MODE=disabled` (or flipping
Registration to **Disabled** in the UI) closes it.
:::

The default is `open` for historical reasons: it used to be the only way to
onboard anyone. **That is no longer true** — an owner can now invite people
directly (see below), so a closed instance can still add exactly the people its
owner names. Closing registration is the right end state for a publicly
reachable instance.

- **First-owner bootstrap is always exempt.** On an instance with **no users**,
  the first registration is accepted regardless of the mode and becomes `owner`.
  A fresh (or reset) deploy is therefore always claimable; every *later* signup
  is subject to the policy.
- **Adding a teammate to a closed instance:** invite them. **Settings → Members
  → Invite a member** takes an email and a role and returns a single-use link.
  Nothing about the instance-wide policy changes, so there is no window during
  which strangers can sign up. See [Invitations](#invitations) below.
  (The old workaround — flip Registration to **Open**, have them register, flip
  it back — still works, since the override applies immediately rather than at
  process start. But it genuinely opens the instance for the length of that
  window, so prefer an invitation.)
- **No account enumeration.** The policy check runs *before* the duplicate-email
  lookup, so a closed instance returns the same `403` for a registered address
  and an unknown one.
- `GET /api/v1/auth/status` reports `registration_enabled` (instance-wide, no
  per-account information), so the sign-in screen hides the sign-up form
  entirely on a closed instance instead of letting a visitor discover the policy
  from a `403`.

Rate limiting (`RATE_LIMIT_REGISTER_PER_HOUR`) still applies on top and is *not*
a substitute: it slows signups, it never closes them.

### Invitations

An owner can add one named person without touching the instance-wide policy.
**Settings → Members → Invite a member** takes an email and a role and returns a
single-use link.

| Property | Behaviour |
|---|---|
| Who can issue one | **Owner only, from an interactive session.** The route uses the dependency that rejects API keys of every scope, so an automation token can never mint an identity. |
| Works while registration is closed | **Yes** — that is the point. Redemption is a separate mechanism from the instance-wide door, not a special case inside it. |
| Address | Fixed by the invitation. The redeem form never asks for one, so a link cannot be turned into an account for someone else. |
| Role | Fixed by the **owner** at invite time. The invitee cannot influence it. |
| Lifetime | 72 hours, single use. Re-inviting the same address invalidates the previous link. |
| Delivery | The link appears **once**, in the response to creating it, and is never retrievable afterwards. Copy it then. This is deliberate: SMTP is optional, so handing the link over out of band has to be a first-class path. |
| Storage | Only a keyed HMAC digest of the token is stored, like session and reset tokens — a leaked `invitations` table is useless without `SECRET_KEY`. |
| Rejection | Unknown, expired and already-used links return one identical error, so a rejected redemption never reveals which it hit. |
| Revoking | **Settings → Members** lists pending invitations; revoking one kills its link immediately. |

Endpoints: `POST`/`GET` `/api/v1/users/invitations`, `DELETE
/api/v1/users/invitations/{id}` (all owner-only), plus the unauthenticated
`GET /api/v1/auth/invitations/{token}` preview and
`POST /api/v1/auth/invitations/{token}/accept`.

### Passwords

Passwords are hashed with **scrypt** (`backend/src/tripl/auth_utils.py`): `N=2^16`, `r=8`, `p=1`, 16-byte random salt, verified with a constant-time comparison (`hmac.compare_digest`). The cost was chosen to harden against offline cracking while still running on a constrained ARM SBC. On a successful login, a hash produced with an older (lower) `N` is opportunistically re-hashed to the current parameters.

### Self-service password reset

Two endpoints back the "Forgot your password?" flow (`backend/src/tripl/api/v1/auth.py`, `services/auth_service.py`):

- `POST /api/v1/auth/password-reset/request` `{ email }` — **always** returns `200` with the same neutral message whether or not the address is registered, so it cannot be used to enumerate accounts. A token is minted and emailed **only** when the instance has SMTP configured (`SMTP_HOST` set) *and* an account matches; otherwise nothing is stored or sent. The response also carries an instance-wide `email_configured` flag (identical for every caller) so the UI can fall back to "contact your owner" copy — this reveals nothing about any specific account.
- `POST /api/v1/auth/password-reset/confirm` `{ token, new_password }` — redeems the token and sets the new password. `new_password` must satisfy the **same policy as registration** (enforced at the schema boundary; `≥ 12` chars with a digit and a symbol). Invalid, expired, and already-used tokens are all rejected with an identical `400` so a rejected token never reveals which case it hit.

Token handling mirrors session tokens and never trusts the raw value:

- The token is `secrets.token_urlsafe(32)` (~256 bits). The **raw token is never stored** — only its HMAC-SHA256 digest keyed by `SECRET_KEY` (`auth_utils.hash_session_token`) lands in `password_reset_tokens`, so a leaked column is useless without the secret.
- **Single-use and short-lived**: each token carries `expires_at` (1 hour, `auth_service.PASSWORD_RESET_TTL_HOURS`) and `used_at`. Confirming marks it used, drops any other outstanding token for that user, and clears all of the user's active sessions (a reset ends other logins).
- Both routes are **rate-limited** via the shared login limiter (see the rate-limiting table above), and email is sent through the existing alert email channel (`worker/tasks/alerts_channels.py`) as a background task — so a slow SMTP round-trip neither blocks the request nor becomes a timing oracle for whether the account exists.

### Session cookies

The session cookie (`backend/src/tripl/api/v1/auth.py`) is set with:

- `HttpOnly` — not readable from JavaScript.
- `SameSite=Lax` — mitigates CSRF on cross-site state-changing requests while allowing top-level navigations.
- `Secure` — controlled by `SESSION_COOKIE_SECURE` (must be `true` in production; enforced by the startup checks).
- `Path=/`, `Max-Age` = `SESSION_TTL_HOURS` × 3600 (default 168h / 7 days).
- Cookie name `SESSION_COOKIE_NAME` (default `tripl_session`).

Sessions are server-side records (`user_sessions`): each carries an expiry, expired sessions are deleted on access, and logout deletes the matching row. On login, that user's already-expired sessions are also pruned.

### Programmatic access (API keys)

For non-browser clients, tripl issues personal API keys (`api_key_service.py`). The raw token has the shape `tk_<scope-letter>_<random>` (e.g. `tk_r_…` / `tk_w_…`); only its SHA-256 hash is stored, so a leaked DB dump cannot replay tokens. Keys carry a scope (`read` / `write`), an optional expiry, and an optional project binding. They are presented as `Authorization: Bearer <token>` and are resolved before cookie auth. See the [Agent API Guide](../integrate/agent-api-guide.md).

## Roles and access control (RBAC)

tripl has three instance roles (`UserRole`: `owner`, `editor`, `viewer`) plus a two-level API-key scope (`ApiKeyScope`: `read`, `write`). The **first** registered user becomes `owner` so the instance always has an operator who can manage roles; every subsequent self-registration defaults to `editor` — and is refused entirely unless registration is `open` (see [Self-service registration](#self-service-registration)).

Enforcement lives in `backend/src/tripl/api/deps.py`. The route-facing FastAPI dependencies are `get_current_user`, `get_write_user`, `get_editor_user`, and `get_owner_user`, which compose the checks below:

| Check | Rule |
|---|---|
| `get_current_user` | Requires a valid Bearer API key or a valid session cookie; else 401 |
| `require_write_scope` | A `read`-scope API key is blocked from mutation endpoints (session users have no scope tag and pass) |
| `require_editor` | `viewer` is rejected; `editor`/`owner` pass |
| `require_owner` | Only `owner` passes |
| `get_owner_user` | Owner-only **and** rejects API keys entirely (any scope) — owner actions require an interactive session |

### Roles are instance-wide, but mutations are scoped per project

The three roles above are properties of the **user**, not of a project — an
`editor` is an editor everywhere. That alone would let anyone who can register
edit every project on the instance, so `get_editor_user` additionally resolves a
per-project scope (`project_service.ProjectMutationScope`) for every slug-scoped
route that carries it. Reads are unaffected; so are routes with no project slug.

| Who is mutating | Verdict |
|---|---|
| An instance `owner` | Allowed |
| The project's creator | Allowed |
| Anyone else, on someone's **demo workspace** | **Denied, always** — a demo belongs to one person |
| Any `editor`, on a project created by an **owner**, or predating creator tracking (`created_by_user_id IS NULL`) | Allowed — this is the shared team tracking plan |
| Any other `editor`, on a project a **different editor** created | **Denied** |

The fourth row is the deliberate part. Strict "creator or owner" everywhere
would have locked editors out of every project they did not personally create —
including every project that predates creator tracking, which has no creator at
all — and that is the entire point of the `editor` role on a normal deployment
where the owner creates projects and editors maintain the plan.

The consequence is worth stating plainly: on a shared project, **any editor can
edit the tracking plan**. If the instance also has registration `open`, anyone
who can reach the URL can become that editor. Close registration, or keep the
instance private.

Two further surfaces carry a stricter gate than the role table alone implies:

| Surface | Gate | Why |
|---|---|---|
| Scan configs — create / update / delete, `preview`, `preview-jobs`, `dry-run`, `dry-run-jobs`, `metrics/replay` | `get_owner_user` (owner, interactive session) | A scan's `base_query` is free-text SQL executed verbatim against an owner-configured warehouse credential, so it can read anything that credential can. Data sources are owner-only; authoring the SQL run against them matches. |
| `POST /scans/{id}/run`, `event-groups/apply`, cancelling a job | `get_editor_user` | Running a **stored** config executes no new SQL, so it stays with the role that maintains the plan — and with the API keys that automate it. Only *authoring* the query is owner-only. |
| `PATCH /api/v1/projects/{slug}` (name, slug, retention) | Project **creator** or owner | Identity, not content: otherwise any editor could rename or re-slug every project on the instance. Stricter than the content rule above, which permits shared-project edits. |
| `GET /data-sources/{id}/schema` | `get_editor_user` | Warehouse table and column names. Editors need it — the scan, metric and fact-table forms drive column pickers off it — but a `viewer` edits none of those. |
| `GET /data-sources/{id}/stats`, and connection details (host, port, username, `password_set`, TLS) on every data-source read | Owner | Non-owners see a data source's name, type and health, which is all the scan picker and metric card need. |
| `GET /api/v1/audit`, `GET /api/v1/audit/{entry_id}` | Owner | The list carries no payload; a payload is read one entry at a time from the detail route, behind the same owner gate. A payload re-exposes both of the rows above: `data_source.*` payloads carry the connection details blanked on a direct read, and `scan_config.create` payloads carry `base_query`. It is also instance-wide — `project_slug` is a filter, not a scope. Passwords were always redacted (`audit_service._redact`). |

`base_query` is additionally validated by the shared read-only-SELECT gate
(`validate_select_sql_safety`, the same one `metric_sql` uses): single statement,
no stacked `;`, no comment markers, no DDL/DML/`UNION`.

Additional guards:

- **Project-scoped API keys are fenced** to their own project: a project-bound key may only touch `/api/v1/projects/{slug}/...` routes for its project; any instance-wide route without a project `slug` (`/me/...`, `/users`, ...) is rejected with 403.
- **Role changes take effect immediately.** Updating a user's role (`PATCH /api/v1/users/{user_id}`, owner-only) deletes all of that user's active sessions, so the next request re-authenticates with the new role. An in-flight request that already passed the auth check completes with the old role; only the next request is affected.
- **The last owner cannot be demoted** — the API rejects demoting the only remaining `owner` with `400`, preventing an instance from being locked out of role management.
- Role changes are written to the audit log (`audit_service.record`, action `user.role_update`).

:::note
Any authenticated user (including `viewer`) can list the user roster (`GET /api/v1/users`). Roles gate **mutations and administration**, not visibility of who exists. Treat the roster as visible to all logged-in users.
:::

## CORS

The effective allow-list is resolved by `Settings.cors_origins()`:

1. `CORS_ALLOW_ORIGINS` (comma-separated explicit origins), else
2. in `DEBUG` mode, the wildcard `*`, else
3. derived from `APP_BASE_URL` if set, else deny all.

Credentialed (cookie) requests require an explicit origin — browsers reject cookies against `*`, and the production startup checks reject both an empty list and a wildcard. The app sends `allow_credentials=true` unless the resolved origin list is exactly `["*"]`. Allowed methods are `GET, POST, PATCH, PUT, DELETE, OPTIONS`; allowed headers are `Authorization`, `Content-Type`, and the request-ID header (`X-Request-ID` by default, configurable via `REQUEST_ID_HEADER`).

## Error and probe hygiene

- Unhandled exceptions return a generic `500 {"detail": "Internal server error", "request_id": ...}` — internal details are logged server-side with the request ID, never returned to the client (`main.py`).
- The unauthenticated `/health` probe returns a generic body (`{"status": "error", "component": "database"}`, HTTP 503) on failure; the underlying DB error (which can leak the DSN, driver, and host) is logged server-side only.
- `/metrics` is only mounted when `PROMETHEUS_METRICS_ENABLED=true`. Keep it on an internal-only ingress path; it is not authenticated by the app.

## Pre-production hardening checklist

Configuration (all enforced by the startup checks unless noted — see [Configuration Reference](./configuration.md) for the full variable list):

- [ ] `DEBUG=false` (or `release`/`prod`/`production`).
- [ ] `SECRET_KEY` set to a long random value, stored in your secret manager.
- [ ] `ENCRYPTION_KEY` set to a valid Fernet key, **backed up separately** from the database.
- [ ] `SESSION_COOKIE_SECURE=true`.
- [ ] `CORS_ALLOW_ORIGINS` (or `APP_BASE_URL`) set to your exact frontend origin — never `*`.
- [ ] `DATABASE_URL`, `SYNC_DATABASE_URL`, `RABBITMQ_URL` use real credentials, not `tripl:tripl` / `guest:guest`.

Transport and headers (your responsibility — not checked by the app):

- [ ] TLS terminated by a reverse proxy / LB in front of the API.
- [ ] `HSTS_ENABLED=true` only after HTTPS is verified end to end.
- [ ] `SECURITY_HEADERS_ENABLED=true` (default); set a reviewed `CONTENT_SECURITY_POLICY` if you are not relying on the SPA default.
- [ ] If a proxy sits in front, set `RATE_LIMIT_TRUST_FORWARDED_FOR=true` **and** confirm the proxy overwrites `X-Real-IP` on every request; otherwise leave it `false`.

Operations:

- [ ] Rate limiting left enabled (`RATE_LIMIT_ENABLED=true`); add a proxy-tier limit if you run multiple workers/replicas.
- [ ] `/metrics` (if enabled) and any admin surfaces restricted to an internal network.
- [ ] First-run owner account created promptly so self-registration cannot grab `owner`.
- [ ] **`REGISTRATION_MODE` decided deliberately. The default is `open`** — anyone who can reach the instance can create an account, read the whole tracking plan and the member roster, and edit any shared project. Set `REGISTRATION_MODE=disabled` (or Registration → **Disabled** in **Settings → Instance → Security & access**) once your team has accounts. Closing it is not a dead end: an owner adds people from **Settings → Members → Invite**, so you never need to reopen self-registration to onboard someone.
- [ ] Database and broker on a private network; `ENCRYPTION_KEY` and `SECRET_KEY` not committed to the repo or image.

For symptom-level help (login loops, blocked CORS, 429s), see [Troubleshooting & FAQ](../use/troubleshooting.md).
