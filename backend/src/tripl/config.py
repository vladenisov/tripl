from __future__ import annotations

from pydantic import field_validator
from pydantic_settings import BaseSettings

# Credential fragments shipped in the dev-default connection URLs. If any of
# these survive into a non-debug deploy, the operator forgot to set real
# secrets — refuse to start. See the `*_url` defaults below.
_DEV_CREDENTIAL_MARKERS = ("tripl:tripl", "guest:guest")

# Self-service registration modes for ``Settings.registration_mode``.
# "open"     — anyone who can reach the instance may create an account. A new
#              account joins as EDITOR: it can read the whole tracking plan and
#              the user roster, and edit any shared project. Data source
#              connection details are owner-only.
# "disabled" — POST /auth/register is refused (403), except for the
#              first-owner bootstrap on an instance with no users yet.
REGISTRATION_OPEN = "open"
REGISTRATION_DISABLED = "disabled"
REGISTRATION_MODES = (REGISTRATION_OPEN, REGISTRATION_DISABLED)


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://tripl:tripl@localhost:5432/tripl"
    sync_database_url: str = "postgresql+psycopg://tripl:tripl@localhost:5432/tripl"
    rabbitmq_url: str = "amqp://guest:guest@localhost:5672//"
    # Empty string disables caching — every read falls through to DB.
    redis_url: str = ""
    encryption_key: str = ""  # Fernet key for encrypting data source secrets
    # Application secret used to key HMAC over session tokens (see
    # auth_utils.hash_session_token). Required in production; rotating it
    # invalidates all existing sessions (users re-login once).
    secret_key: str = ""
    app_base_url: str = ""
    session_cookie_name: str = "tripl_session"
    session_ttl_hours: int = 24 * 7
    session_cookie_secure: bool = False
    debug: bool = False

    # CORS. Comma-separated explicit origin list. Empty means: derive from
    # app_base_url in production, or permissive ("*") in debug.
    cors_allow_origins: str = ""

    # Security headers and HSTS.
    security_headers_enabled: bool = True
    # HSTS is opt-in; only safe behind HTTPS with secure cookies.
    hsts_enabled: bool = False
    hsts_max_age_seconds: int = 31_536_000  # 1 year
    # Optional Content-Security-Policy. Default leaves it unset so the app
    # doesn't break before a CSP is reviewed for the deployed origin. When
    # serve_frontend is on and this is empty, a SPA-appropriate CSP is applied
    # automatically (see SecurityHeadersMiddleware) so consolidating doesn't drop
    # the policy the standalone static tier used to set.
    content_security_policy: str = ""

    # Frontend serving. When serve_frontend is true the API also serves the built
    # SPA from frontend_dist_dir via app.frontend() (FastAPI 0.138+; API path
    # operations are checked first, SPA files are the low-priority fallback), so
    # production can run a single container instead of api + a separate static
    # tier. Off by default: in development the Vite dev server serves the SPA with
    # HMR and proxies /api to the backend.
    serve_frontend: bool = False
    frontend_dist_dir: str = ""

    # Rate limiting for auth endpoints. Counts are per (ip, route).
    # 0 disables rate limiting on that route. Backed by in-memory token bucket
    # per worker; for multi-worker deployments, run behind a fronting LB or
    # swap to a shared store.
    rate_limit_enabled: bool = True
    rate_limit_login_per_minute: int = 5
    rate_limit_register_per_hour: int = 3
    # Whether to derive the client IP from proxy-supplied headers (X-Real-IP,
    # then leftmost X-Forwarded-For) for rate-limit bucketing. Defaults to FALSE:
    # use the direct socket peer (request.client.host), which is correct when the
    # API is the edge — including the consolidated single container where FastAPI
    # serves the SPA itself (serve_frontend) with no proxy in front. Enable this
    # ONLY when a trusted proxy/LB sits in front and *overwrites* X-Real-IP with
    # the real client address on every request; a raw X-Forwarded-For is
    # attacker-controlled, so trusting it on a directly-exposed API lets an
    # unauthenticated caller rotate it per request to bypass the limit entirely.
    rate_limit_trust_forwarded_for: bool = False

    # Self-service registration. One of REGISTRATION_MODES. Defaults to "open".
    #
    # This is a deliberate, documented trade-off, not an oversight. "open" means
    # anyone who can reach this instance can create an account, joining as
    # EDITOR — so they can immediately read the whole tracking plan and the user
    # roster, AND edit any shared project. A data source's connection details
    # (host, port, username) are owner-only; the password is never returned to
    # anybody. Note the write half: "can read X" alone understates it. It is the
    # default for historical reasons (tripl-jfm3.80): it was once the only way to
    # onboard anyone, since /api/v1/users had no create route, there was no
    # invite flow, and SMTP is optional — so "disabled" left real instances
    # unable to add anybody at all. That is no longer true. An owner can invite
    # a named person at a chosen role (POST /api/v1/users/invitations, redeemed
    # via POST /api/v1/auth/invitations/{token}/accept), and that path works
    # while registration is "disabled" and needs no SMTP.
    #
    # So the default is now a compatibility choice, not a necessity, and closing
    # registration is the right end state for a publicly reachable instance —
    # REGISTRATION_MODE env var, or Settings -> Instance -> Security & access,
    # which takes effect on the very next request with no redeploy. See
    # website/docs/run/security.md.
    registration_mode: str = REGISTRATION_OPEN

    # Event photo uploads. Backend can be "local" (filesystem) or "gcs"
    # (Google Cloud Storage). Local files are served through an authenticated
    # API endpoint; GCS uses time-limited signed URLs unless gcs_photo_public
    # is true.
    photo_storage_backend: str = "local"
    photo_local_dir: str = "./var/photos"
    photo_max_size_mb: int = 10
    photo_allowed_mime: str = "image/jpeg,image/png,image/gif,image/webp"
    gcs_photo_bucket: str = ""
    # Path to a service-account JSON. Empty falls back to Application Default
    # Credentials (e.g. GOOGLE_APPLICATION_CREDENTIALS or workload identity).
    gcs_photo_credentials_path: str = ""
    gcs_photo_public: bool = False
    gcs_photo_signed_url_ttl_seconds: int = 3600

    # Request ID and structured logging.
    request_id_header: str = "X-Request-ID"
    log_level: str = "INFO"
    # When true, logs are emitted as one-line JSON. Default is plain text for
    # interactive dev; compose / k8s manifests should enable this.
    log_json: bool = False

    # Prometheus `/metrics` endpoint + Celery task instrumentation. Off by
    # default so dev runs stay quiet; production / staging should turn it on
    # behind an internal-only ingress path.
    prometheus_metrics_enabled: bool = False

    # Hybrid knowledge search. Lexical/fuzzy search is local to PostgreSQL;
    # embeddings are opt-in because indexed text may include internal tracking
    # plan content sent to the configured provider.
    search_embeddings_enabled: bool = False
    search_embedding_provider: str = "openai"
    search_embedding_model: str = "text-embedding-3-small"
    search_embedding_dimensions: int = 1536
    search_embedding_api_key: str = ""
    # Where the OpenAI-COMPATIBLE embeddings endpoint lives (tripl-0tt4).
    #
    # The docs have told self-hosters since this feature shipped that they can
    # "keep all text inside your own infrastructure — point SEARCH_EMBEDDING_*
    # and AI_BASE_URL at that endpoint". AI_BASE_URL existed; this did not, and
    # embedding_service.py hardcoded api.openai.com. So a reader who followed the
    # written instruction shipped their tracking-plan text to OpenAI while
    # believing it stayed internal, with their own credential attached.
    #
    # ENV-ONLY, deliberately, and not an oversight for someone to "complete"
    # later by threading it through AiConfig: the vectors already in pgvector
    # came from whatever endpoint produced them, and similarity between two
    # different embedding spaces is meaningless. Repointing this at runtime would
    # silently poison the index for every document written before the change,
    # with no error anywhere. It is the argument search_embedding_dimensions is
    # env-only for, stated at its use site in embedding_service.py: changing
    # either means re-embedding the corpus, which is a deploy and not a toggle.
    #
    # A BASE, not a full URL, matching ai_base_url — llm_service builds
    # `ai_base_url.rstrip("/") + "/chat/completions"` and this is read the same
    # way, so one provider's two endpoints are configured alike.
    search_embedding_base_url: str = "https://api.openai.com/v1"
    openai_api_key: str = ""

    # OpenTelemetry tracing. Setting `otel_exporter_otlp_endpoint` to a non-
    # empty string opts the API + worker into FastAPI/SQLAlchemy/Celery auto-
    # instrumentation with an OTLP exporter. No-op when the env is blank or
    # the opentelemetry-* packages aren't installed (graceful — keeps the
    # base image lean).
    otel_exporter_otlp_endpoint: str = ""
    otel_service_name: str = "tripl"

    # SMTP for the email alert delivery channel. Optional — leaving smtp_host
    # blank disables email destinations (creation still works; sends fail with
    # a friendly error pointing at this config). Worker reads these at send time
    # so config changes take effect without re-creating destinations.
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_use_tls: bool = True
    # Default From: address used when a destination doesn't override it.
    smtp_from_address: str = ""

    # Warehouse query row caps used by scan/replay when scan-config specific
    # overrides are not set.
    scan_row_limit_default: int = 50_000
    metrics_row_limit_default: int = 100_000

    # Master rollback switch for the generated-demo feature. When false, the
    # self-service demo creation path (``POST /projects/demo`` and the
    # legacy/outdated upgrade path, which re-provisions) is refused with 403 —
    # a one-flag kill switch if demo provisioning ever misbehaves in production.
    # It gates ONLY demo provisioning: REAL project create/scan/delete and every
    # non-demo surface are entirely unaffected in any state of this flag.
    demo_enabled: bool = True

    # Demo runtime tick (``advance_demos`` beat task). When true, active demos are
    # kept fresh by appending new synthetic buckets/jobs/signals on a schedule.
    # When false the beat task is a no-op — REAL scan/metric scheduling
    # (check_metrics_due / check_metric_definitions_due) is entirely unaffected,
    # so this only turns demo self-advancement on or off.
    demo_runtime_enabled: bool = True

    # AI features (LLM-powered descriptions, Q&A). Disabled by default because
    # plan content — event names, descriptions, field names — is sent to the
    # configured provider when enabled.
    ai_enabled: bool = False
    ai_base_url: str = "https://api.openai.com/v1"
    ai_model: str = "gpt-4o-mini"
    ai_api_key: str = ""
    ai_timeout_seconds: int = 30
    ai_max_output_tokens: int = 700

    # env_ignore_empty is load-bearing, not tidiness. compose.yaml passes ~25
    # optional settings as `VAR: ${VAR:-}`, and Compose's map syntax materialises
    # an undefined variable as the empty STRING inside the container rather than
    # leaving it unset. Without this flag pydantic then tries to parse "" as a
    # bool/int/enum and `Settings()` — constructed at import, at the bottom of
    # this module — raises on every fresh deploy, so the app container exits
    # before it serves a byte. With it, an empty value means "unset" and falls
    # through to the default below, which is exactly what that compose comment
    # always claimed. Deleting the `${VAR:-}` lines instead would reintroduce
    # tripl-2su6.16 / tripl-jfm3.101, where a documented switch silently did
    # nothing (tripl-ey6j.3).
    model_config = {"env_file": ".env", "extra": "ignore", "env_ignore_empty": True}

    @field_validator("debug", mode="before")
    @classmethod
    def _normalize_debug(cls, value: object) -> object:
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized in {"release", "prod", "production"}:
                return False
            if normalized in {"dev", "development"}:
                return True
        return value

    @field_validator("log_level")
    @classmethod
    def _normalize_log_level(cls, value: str) -> str:
        return value.upper().strip()

    @field_validator("registration_mode")
    @classmethod
    def _normalize_registration_mode(cls, value: str) -> str:
        # Fail fast on a typo'd REGISTRATION_MODE rather than silently treating
        # an unknown value as one mode or the other.
        normalized = value.strip().lower()
        if normalized not in REGISTRATION_MODES:
            msg = f"registration_mode must be one of {', '.join(REGISTRATION_MODES)}"
            raise ValueError(msg)
        return normalized

    def cors_origins(self) -> list[str]:
        """Resolve effective CORS origin allow-list.

        Order of precedence:
        1. ``cors_allow_origins`` env (comma-separated).
        2. In debug mode with no explicit list, fall back to ``*``.
        3. Otherwise, derive from ``app_base_url`` if set; else deny all.
        """
        if self.cors_allow_origins:
            return [o.strip() for o in self.cors_allow_origins.split(",") if o.strip()]
        if self.debug:
            return ["*"]
        if self.app_base_url:
            return [self.app_base_url.rstrip("/")]
        return []

    def assert_production_ready(self) -> None:
        """Refuse to start in non-debug mode without required secrets.

        Called from the FastAPI lifespan; tests and CLI tools that import the
        Settings object directly are not blocked.
        """
        problems = self.production_problems()
        if problems:
            raise RuntimeError("Production startup checks failed:\n  - " + "\n  - ".join(problems))

    def production_problems(self) -> list[str]:
        """Everything that would make ``assert_production_ready`` refuse to boot.

        Split out so a caller can ask "would THIS change break startup?" by
        diffing two settings objects, instead of inheriting every unrelated
        complaint the ambient environment already carries (tripl-jfm3.93).
        """
        if self.debug:
            return []

        problems: list[str] = []

        if not self.encryption_key:
            problems.append(
                "ENCRYPTION_KEY is empty: data-source and alert-destination secrets "
                "would be stored as plaintext. Generate one with "
                "`python -c 'from cryptography.fernet import Fernet; "
                "print(Fernet.generate_key().decode())'`."
            )
        else:
            from cryptography.fernet import Fernet

            try:
                Fernet(self.encryption_key.encode())
            except (ValueError, TypeError) as exc:
                problems.append(f"ENCRYPTION_KEY is not a valid Fernet key: {exc}")

        if not self.session_cookie_secure:
            problems.append(
                "SESSION_COOKIE_SECURE=false in production: session cookies will be "
                "sent over HTTP. Set SESSION_COOKIE_SECURE=true when serving over HTTPS."
            )

        if not self.secret_key:
            problems.append(
                "SECRET_KEY is empty: session token hashes would be unkeyed and "
                "guessable. Set SECRET_KEY to a long random value (e.g. "
                "`python -c 'import secrets; print(secrets.token_urlsafe(32))'`)."
            )

        resolved_cors = self.cors_origins()
        if not resolved_cors:
            problems.append(
                "CORS origins are empty: no browser can call the API. Set "
                "CORS_ALLOW_ORIGINS or APP_BASE_URL to your frontend origin."
            )
        elif resolved_cors == ["*"]:
            problems.append(
                "CORS origins resolve to the wildcard '*' in production: browsers "
                "reject credentialed (cookie) requests against a wildcard origin, "
                "so session auth would break. Set CORS_ALLOW_ORIGINS or "
                "APP_BASE_URL to an explicit frontend origin."
            )

        for label, url in (
            ("DATABASE_URL", self.database_url),
            ("SYNC_DATABASE_URL", self.sync_database_url),
            ("RABBITMQ_URL", self.rabbitmq_url),
        ):
            if any(marker in url for marker in _DEV_CREDENTIAL_MARKERS):
                problems.append(
                    f"{label} still uses the dev-default credentials "
                    f"({' / '.join(_DEV_CREDENTIAL_MARKERS)}): set a real "
                    "connection string before deploying."
                )

        return problems

    def resolved_search_embedding_api_key(self) -> str:
        return self.search_embedding_api_key or self.openai_api_key

    def resolved_ai_api_key(self) -> str:
        return self.ai_api_key or self.openai_api_key


settings = Settings()
