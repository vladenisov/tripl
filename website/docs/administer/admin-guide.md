---
title: Administration & Instance Settings
sidebar_position: 1
---

# Administration & Instance Settings

This page is for the people who run a tripl instance: managing members, granting
the right level of access, issuing API keys for agents and scripts, and tuning
the server-wide settings the app exposes in its UI.

tripl is a single multi-user instance ("workspace") that contains every project.
Almost everything an administrator does lives under **Settings**, which has two
contexts:

- **Workspace** — Members, Data sources, API keys, your own Profile and
  Security, and the owner-only **Instance** sections.
- **Project** — per-project configuration (General, Plan rules), covered in the
  user guide rather than here.

:::note Settings vs. environment variables
The **Instance** sections in the UI let an owner override a subset of the
server's configuration, stored in the instance database. Everything else —
database/broker URLs, the encryption key, the application secret — is set only
through environment variables. Sections differ in **when** an override applies —
some at use-time, some on the next restart (see [When changes take effect](#when-changes-take-effect)).
For the full env-var reference (including the variables behind the settings
below) see [Configuration](../run/configuration.md).
:::

## Roles & permissions

tripl has exactly three roles, defined server-side as the `UserRole` enum
(`owner`, `editor`, `viewer`):

| Role | Can read | Can edit plan content | Manage members & roles | Instance settings |
| --- | --- | --- | --- | --- |
| **Viewer** | Yes | No | No | No |
| **Editor** | Yes | Yes | No | No |
| **Owner** | Yes | Yes | Yes | Yes |

How roles are assigned:

- **The first user to register becomes `owner`.** This guarantees every instance
  has at least one operator who can manage roles. Every subsequent registration
  defaults to **`editor`**.
- A **`viewer`** is never created automatically — an owner has to downgrade a
  member to viewer in **Settings → Members**.
- Only an **owner** can change anyone's role. The API refuses to **demote the
  last remaining owner** (`400 Cannot demote the last remaining owner`), so you
  cannot lock yourself out of the instance.

:::warning Role changes sign the user out
When an owner changes a member's role, every active session for that user is
deleted in the same transaction, so the new permissions take effect on their
next request. An in-flight request that already passed authentication still
finishes with the old role; only the next request is affected.
:::

### How permissions are enforced

The backend gates endpoints with role/scope dependencies, not just UI hiding:

- **Editor-or-above** is required for any mutation. Viewers receive `403 Editor
  role required`.
- **Owner** is required for member role changes and all Instance settings.
  Non-owners receive `403 Owner role required`.
- Owner-only endpoints additionally require an **interactive owner session** —
  an API key can never reach them, even a write-scoped key owned by an owner
  (`403 Owner session required`).

## Members

**Settings → Members** lists everyone with access to the workspace. The roster
itself is visible to any authenticated user; **only owners** see the per-row
role dropdown and can change roles. Non-owners see read-only role chips.

Each row shows the member's name (or email), email, join date, and role
(**Owner** / **Editor** / **Viewer**). Owners cannot change their *own* role from
this screen — use another owner account if you need to step down, and remember
the last-owner guard above.

:::warning No invitations yet — registration is the only way in, and it ships open
There is no email-invitation flow in the current release and no
owner-creates-user endpoint, so **self-service registration is the only way to
add a person** — which is why it ships **open by default**. On an open instance
anyone who can reach the URL can sign up, join as **editor**, and immediately
read the whole tracking plan, this member roster, and every data source's
connection metadata. Decide the policy before you expose the instance; see
[Security & access](#security--access) and
[Security & Hardening](../run/security.md#self-service-registration).

Adding a member while registration is **Open**: have them register at the
sign-in page, then adjust their role from **Settings → Members**.

Adding a member once you have closed it:

1. **Settings → Instance → Security & access → Registration** → set **Open**.
   (Owner only. This applies immediately — no restart.)
2. Have them **register** at the sign-in page. They join as **editor**; adjust
   their role from **Settings → Members** if needed.
3. Set Registration back to **Disabled**.

The instance really is open for the length of that window, so keep it short.
While registration is disabled the sign-in page shows no sign-up form at all,
and `POST /auth/register` is refused with a `403` that tells the visitor to ask
an owner. The one exception is an instance with **no users at all** — that first
registration always works and becomes the owner, so a fresh or reset deploy can
always be claimed. Registration is also rate-limited (see
[Security & access](#security--access)).
:::

## Profile & account security

These two sections live under **Settings → Account** and apply only to the
signed-in user.

### Profile

**Settings → Profile** shows your details pulled from the authenticated account:

- **Full name**, **Email**, and **Role** — all read-only here. Role is "Set by a
  workspace owner."

:::warning Profile preferences are not persisted server-side
Avatar upload, the **Preferences** block (Timezone, Date format, Start of week)
and the **Notifications** toggles (Incident alerts, Review requests, Weekly
digest) are presentation-only in this release. They operate on local state and
are **not** backed by an API endpoint, so they do not save across devices or
sessions. Treat them as not-yet-wired.
:::

### Account security

**Settings → Security** presents Password change, Two-factor authentication, and
Active-session management.

:::danger Account-security controls are not functional yet
The password-change form, 2FA toggle, recovery codes, and the "Sign out all" /
active-sessions list are **presentation-only placeholders** — there are no
backend endpoints behind them in the current release. The only real
authentication flows are **register**, **login**, and **logout**. To invalidate
a user's sessions today, change their role (which deletes their sessions) or
have them log out. Sessions also expire automatically after the configured TTL
(`session_ttl_hours`, default **168 hours / 7 days**).
:::

## API keys & governance

API keys are long-lived bearer tokens for non-browser clients — LLM agents and
CLI scripts. They are managed **per user** at **Settings → API keys** (backed by
`/api/v1/me/api-keys`). A user only ever sees and revokes **their own** keys;
there is no cross-user key administration, even for owners.

### Creating a key

The create form (and the `POST /api/v1/me/api-keys` endpoint) takes:

| Field | Notes |
| --- | --- |
| **Name** | Required, 1–100 chars. A human label (e.g. `claude-agent`). |
| **Scope** | `read` (default) or `write`. See below. |
| **Project** | Optional. Bind the key to a single project by slug, or leave as **All projects** for full account reach. |
| **Expires in (days)** | Optional, 1–3650. Blank means **no expiration**. |

**Scopes:**

- **`read`** — read/query operations only. Mutation surfaces return `403 API key
  has read-only scope`; a few complex read-only queries use `POST` with a JSON
  body and remain available.
- **`write`** — full editor-level access, *still subject to the owning user's
  role*. A write key is useless beyond reading if its owner is a viewer.
  Creating a write-scoped key itself requires the creator to be **editor or
  above** (a viewer cannot mint a write key, and the UI hides the option).

**Project binding** is orthogonal to scope. A project-bound key authenticates
**only** `/projects/{slug}/...` routes for that one project; any other project
(`403 API key is not authorized for this project`), or any instance-wide route
(`/me/...`, `/users`, ...), is rejected (`403 API key is scoped to a single
project`). Use it to fence an agent into a single project. Unbound keys keep
full cross-project reach.

:::tip The token is shown exactly once
On creation, the full token is returned a single time and displayed in a
"Copy your API key now" dialog. Copy it immediately — only a non-secret
**prefix** (`tk_<scope-letter>_<first chars>`, e.g. `tk_r_…` / `tk_w_…`) is
stored and shown afterward. Server-side, only a SHA-256 **hash** of the token is
persisted, so a database dump cannot replay tokens.
:::

### Governing keys

- **Inventory.** The **All keys** card lists every key with its name, prefix,
  scope chip (`read`/`write`), bound project (or "All projects"), and
  last-used / status (`never used`, `used <date>`, `expired`, or `revoked`).
  Its heading counts usable keys separately from dead ones — "7 active · 3
  revoked or expired" — so the summary never files a revoked token as live.
  `last_used_at` is updated on use but throttled to at most once per ~60s to
  avoid write amplification on the auth hot path.
- **Revocation is immediate and soft.** Revoking sets `revoked_at`; the key
  stops authenticating at once (callers begin receiving `401`). Revoke is
  idempotent. Creating and revoking keys are recorded in the **audit log**
  (`api_key.create` / `api_key.revoke`).
- **Expiry** is enforced server-side: an expired key authenticates as if
  unknown (`401`).

For how clients present these tokens (the `Authorization: Bearer <token>`
header) and the endpoints they unlock, see the
[Agent API guide](../integrate/agent-api-guide.md).

## Instance settings (owner only)

**Settings → Instance** is visible only to owners — non-owner accounts see an
"Owner role is required to view or change instance-level settings" message, and
the API rejects them (`GET`/`PATCH`/`PUT /api/v1/settings` all require an owner
session). It exposes a curated subset of the server configuration as overrides
stored in the database.

### How overrides work

Each editable field resolves as **database override → environment value**. The
defaults come from the environment / `Settings` object; saving a value in the UI
writes an override row, and a per-section **Reset** removes the override so the
field falls back to its env value. Most fields carry a small **source badge**
showing whether the value is currently coming from `env` or an `override`.

:::note Secrets are write-only
Secret fields — the AI API key, the search-embedding API key, and the SMTP
password — are **encrypted at rest** (Fernet) and never returned to the browser.
The UI shows only a `Configured` / `Not configured` placeholder; leave the field
blank to keep the existing value, type a new value to replace it, or use
**Clear** to remove the override. Encryption requires `ENCRYPTION_KEY` to be set
(see [Configuration](../run/configuration.md)).
:::

#### When changes take effect

Sections apply at one of two times:

**Use-time (no restart).** The **Runtime** (query limits, app base URL),
**Email**, and **AI** sections are resolved override → env value on each call, so
edits apply immediately. The worker falls back to env-only config if it can't
read the settings table, so background jobs never fail on a settings read.

**Restart-time (next deploy).** The **Security & access** (except
**Registration**, which applies immediately), **Storage**, and
**Observability** sections are consumed by parts of the server that are wired
once at process start — the middleware stack (CORS, security headers, the
session cookie), the auth rate limiters, the photo storage backend, logging, and
the metrics route. At startup the saved overrides are **applied onto the running
configuration** before any of those are built, so they take effect on the **next
restart/redeploy** — exactly what the UI's "overrides take effect on the next
deploy" note means. You no longer need to also set the matching environment
variable; the env var is just the default the override replaces.

:::note A running process won't pick these up live
Because these sections are read once at boot, editing them does **not** change a
process that's already running — restart the API (and worker) container for the
new values to take effect. A bad value (e.g. a CORS origin that locks you out)
is recovered the same way you set it: edit it back, or clear the override, and
restart. The matching environment variable still works as the baseline default —
see [Configuration](../run/configuration.md).
:::

The sections, with the fields each exposes:

### Runtime

Core server configuration.

- **App base URL** — used in emails, webhooks and the ingest endpoint
  (`app_base_url`).
- **Scan row limit default** — default warehouse row cap for scans
  (`scan_row_limit_default`, default 50,000).
- **Metrics row limit default** — default row cap for metric queries
  (`metrics_row_limit_default`, default 100,000).

### Email

SMTP transport for alert delivery (and, in the UI's framing, invitations and
digests). Leaving **SMTP host** blank disables email destinations.

- **SMTP host** (`smtp_host`)
- **Port** (`smtp_port`, default 587)
- **SMTP username** (`smtp_username`)
- **SMTP password** (`smtp_password`, secret — write-only)
- **Use TLS** (`smtp_use_tls`, default on)
- **Default From address** (`smtp_from_address`) — used when a destination
  doesn't override it.

### AI

Powers anomaly explanations, schema/description suggestions, and the assistant.
Disabled by default because plan content is sent to the configured provider when
enabled.

- **Provider:** AI enabled (`ai_enabled`), Base URL (`ai_base_url`, default
  `https://api.openai.com/v1`; http and localhost endpoints such as a local LLM
  are allowed), Model (`ai_model`, default `gpt-4o-mini`), **AI API key**
  (`ai_api_key`, secret), and a **Test AI** button that runs a live connection
  check against the provider.
- **Generation:** Timeout seconds (`ai_timeout_seconds`, default 30), Max output
  tokens (`ai_max_output_tokens`, default 700), and three editable system
  prompts — **Describe prompt**, **Ask prompt**, **Alert explanation prompt** —
  which fall back to built-in defaults.
- **Search embeddings:** toggle (`search_embeddings_enabled`), read-only
  **Embedding dimensions** (`search_embedding_dimensions`, default 1536, env
  only), provider (`search_embedding_provider`, default `openai`), model
  (`search_embedding_model`, default `text-embedding-3-small`), and **Embedding
  API key** (`search_embedding_api_key`, secret).

If no key is set on either AI secret field, the server falls back to the
`OPENAI_API_KEY` environment value when resolving the effective key.

### Security & access

Authentication and network policy for everyone on the instance.

- **Registration** (`registration_mode`, default **Open**) — whether strangers
  can create their own account. **Open** allows self-service signup: anyone who
  can reach this instance creates an account, joins as **editor**, and can
  immediately read the whole tracking plan, the member roster, and every data
  source's connection metadata (name, type, host, port, username — never the
  password). **Disabled** refuses `POST /auth/register` with a `403` and hides
  the sign-up form on the sign-in page. It defaults to Open only because there
  is no invite or owner-creates-user flow yet, so a closed instance cannot
  onboard anyone; close it once your team has accounts. See
  [Members](#members) for the onboarding flow.
- **Sessions:** Session cookie name (`session_cookie_name`, default
  `tripl_session`), Session TTL hours (`session_ttl_hours`, default 168), Secure
  cookie (`session_cookie_secure`).
- **Network & headers:** CORS allow origins (`cors_allow_origins`, comma-
  separated), Security headers (`security_headers_enabled`), HSTS
  (`hsts_enabled`) and HSTS max age (`hsts_max_age_seconds`), Content Security
  Policy (`content_security_policy`).
- **Rate limiting:** master toggle (`rate_limit_enabled`), Login limit
  (`rate_limit_login_per_minute`, default 5/min), Register limit
  (`rate_limit_register_per_hour`, default 3/hour), and **Trust
  X-Forwarded-For** (`rate_limit_trust_forwarded_for`).

:::tip Registration is the one field here that applies immediately
Everything else in this section is read once at process start (see
[When changes take effect](#when-changes-take-effect)), but **Registration** is
resolved on every signup attempt — closing the door must never wait for a
redeploy. The `REGISTRATION_MODE` env var remains the default the override
replaces.
:::

:::danger Trust X-Forwarded-For only behind a trusted proxy
`rate_limit_trust_forwarded_for` defaults to **false**. Enable it only when a
trusted proxy/load balancer sits in front and overwrites `X-Real-IP` on every
request. On a directly-exposed API, a raw `X-Forwarded-For` is
attacker-controlled — trusting it lets an unauthenticated caller rotate the
header per request and bypass the rate limit entirely. Because this section is
read from the environment, set it via the `RATE_LIMIT_TRUST_FORWARDED_FOR` env
var, not the UI override.
:::

### Storage

Where event photos are persisted (`photo_storage_backend`: **Local filesystem**
or **Google Cloud Storage**).

- **Backend:** Photo storage backend, Photo max size (`photo_max_size_mb`,
  default 10), Allowed MIME types (`photo_allowed_mime`).
- **Local filesystem:** Local photo directory (`photo_local_dir`, default
  `./var/photos`).
- **Google Cloud Storage:** GCS bucket (`gcs_photo_bucket`), GCS public URLs
  (`gcs_photo_public`), GCS credentials path (`gcs_photo_credentials_path`,
  blank falls back to Application Default Credentials), Signed URL TTL
  (`gcs_photo_signed_url_ttl_seconds`, default 3600).

### Observability

How tripl reports its own health.

- **Logging:** Log level (`log_level`: DEBUG/INFO/WARNING/ERROR/CRITICAL,
  default INFO), JSON logs (`log_json`), Request ID header
  (`request_id_header`, default `X-Request-ID`).
- **Metrics & tracing:** Prometheus metrics (`prometheus_metrics_enabled` —
  exposes `/metrics`), OTLP endpoint (`otel_exporter_otlp_endpoint` — setting a
  non-empty value opts the API and worker into OpenTelemetry auto-
  instrumentation), OTEL service name (`otel_service_name`, default `tripl`).

### System (read-only)

A health/build panel. Each tile shows **Configured** or **Unset** for: Debug
mode, Database URL, Sync database URL, RabbitMQ URL, Redis URL, Encryption key,
and the OpenAI fallback key. Nothing here is editable — it reflects the
process's environment so you can confirm the instance is wired correctly.

## Related pages

- [Configuration](../run/configuration.md) — the full environment-variable
  reference behind these settings.
- [Security](../run/security.md) — hardening the instance (secrets, HTTPS, CORS).
- [Deployment](../run/deployment.md) — running the instance (compose / GHCR
  image) and what a restart picks up.
- [Agent API guide](../integrate/agent-api-guide.md) — using API keys from
  agents and scripts.
- [Troubleshooting](../use/troubleshooting.md) — common operational issues.
