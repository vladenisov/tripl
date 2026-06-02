from __future__ import annotations

from pydantic import field_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://tripl:tripl@localhost:5432/tripl"
    sync_database_url: str = "postgresql+psycopg://tripl:tripl@localhost:5432/tripl"
    rabbitmq_url: str = "amqp://guest:guest@localhost:5672//"
    # Empty string disables caching — every read falls through to DB.
    redis_url: str = ""
    encryption_key: str = ""  # Fernet key for encrypting data source secrets
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
    # doesn't break before a CSP is reviewed for the deployed origin.
    content_security_policy: str = ""

    # Rate limiting for auth endpoints. Counts are per (ip, route).
    # 0 disables rate limiting on that route. Backed by in-memory token bucket
    # per worker; for multi-worker deployments, run behind a fronting LB or
    # swap to a shared store.
    rate_limit_enabled: bool = True
    rate_limit_login_per_minute: int = 5
    rate_limit_register_per_hour: int = 3

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

    model_config = {"env_file": ".env", "extra": "ignore"}

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
        if self.debug:
            return

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

        if not self.cors_origins():
            problems.append(
                "CORS origins are empty: no browser can call the API. Set "
                "CORS_ALLOW_ORIGINS or APP_BASE_URL to your frontend origin."
            )

        if problems:
            raise RuntimeError("Production startup checks failed:\n  - " + "\n  - ".join(problems))

    def resolved_search_embedding_api_key(self) -> str:
        return self.search_embedding_api_key or self.openai_api_key


settings = Settings()
