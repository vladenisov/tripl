"""Serving the built SPA from FastAPI via app.frontend() (tripl-jmve).

The consolidated single-container prod deploy serves the SPA from the API process
using FastAPI 0.138+'s app.frontend(). These tests pin the behavior that makes
that safe: API path operations keep precedence, unmatched paths fall back to
index.html for client-side routing, static assets are served, and — because the
SPA now flows through SecurityHeadersMiddleware — a CSP is applied when
serve_frontend is on. The tests use throwaway apps so they don't depend on the
main app's serve_frontend flag (off by default in dev/tests).
"""

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from tripl.config import settings
from tripl.middleware import SecurityHeadersMiddleware


def _make_dist(tmp_path: Path) -> Path:
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>tripl SPA</title>")
    (dist / "assets" / "app.js").write_text("console.log('app')")
    return dist


def _spa_app(dist: Path) -> FastAPI:
    app = FastAPI()

    @app.get("/api/ping")
    def ping() -> dict[str, str]:
        return {"pong": "1"}

    app.frontend("/", directory=str(dist), fallback="index.html")
    return app


def test_api_routes_take_precedence_over_spa(tmp_path: Path) -> None:
    resp = TestClient(_spa_app(_make_dist(tmp_path))).get("/api/ping")
    assert resp.status_code == 200
    assert resp.json() == {"pong": "1"}


def test_root_serves_index_html(tmp_path: Path) -> None:
    resp = TestClient(_spa_app(_make_dist(tmp_path))).get("/")
    assert resp.status_code == 200
    assert "tripl SPA" in resp.text


def test_client_side_route_falls_back_to_index(tmp_path: Path) -> None:
    resp = TestClient(_spa_app(_make_dist(tmp_path))).get("/projects/deep/route")
    assert resp.status_code == 200
    assert "tripl SPA" in resp.text


def test_static_asset_is_served(tmp_path: Path) -> None:
    resp = TestClient(_spa_app(_make_dist(tmp_path))).get("/assets/app.js")
    assert resp.status_code == 200
    assert "console.log" in resp.text


def test_default_spa_csp_applied_when_serving_frontend(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "serve_frontend", True)
    monkeypatch.setattr(settings, "content_security_policy", "")
    app = _spa_app(_make_dist(tmp_path))
    app.add_middleware(SecurityHeadersMiddleware)
    csp = TestClient(app).get("/").headers.get("content-security-policy")
    assert csp == (
        "default-src 'self'; script-src 'self'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "img-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com; "
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    )
