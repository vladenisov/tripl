import importlib.util
from pathlib import Path
from types import SimpleNamespace

from alembic.config import Config
from alembic.script import ScriptDirectory


def test_alembic_revision_graph_has_single_head() -> None:
    backend_root = Path(__file__).resolve().parents[3]
    config = Config(str(backend_root / "alembic.ini"))
    config.set_main_option("script_location", str(backend_root / "alembic"))

    script = ScriptDirectory.from_config(config)

    heads = script.get_heads()

    assert len(heads) == 1


def test_project_app_version_retention_migration_backfills_and_mirrors(
    monkeypatch,
) -> None:
    backend_root = Path(__file__).resolve().parents[3]
    migration_path = (
        backend_root / "alembic" / "versions" / "0f3a4b5c6d7e_add_project_app_version_retention.py"
    )
    spec = importlib.util.spec_from_file_location(
        "project_version_retention_migration", migration_path
    )
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)

    statements: list[str] = []
    monkeypatch.setattr(
        migration.op,
        "get_bind",
        lambda: SimpleNamespace(dialect=SimpleNamespace(name="postgresql")),
    )
    monkeypatch.setattr(migration.op, "add_column", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(
        migration.op, "execute", lambda statement: statements.append(str(statement))
    )

    migration.upgrade()

    assert len(statements) == 2
    backfill, mirror = (" ".join(statement.split()) for statement in statements)
    assert "MIN(app_version_keep_releases)" in backfill
    assert "app_version_column IS NOT NULL" in backfill
    assert "SET app_version_keep_releases = project.app_version_keep_releases" in mirror
    assert "scan.app_version_column IS NOT NULL" in mirror
