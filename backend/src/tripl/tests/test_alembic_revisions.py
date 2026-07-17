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


def test_missing_timestamp_server_defaults_migration_sets_and_drops_defaults(
    monkeypatch,
) -> None:
    backend_root = Path(__file__).resolve().parents[3]
    migration_path = (
        backend_root
        / "alembic"
        / "versions"
        / "d4e5f6a7b8c9_add_missing_timestamp_server_defaults.py"
    )
    spec = importlib.util.spec_from_file_location(
        "missing_timestamp_server_defaults_migration", migration_path
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
    monkeypatch.setattr(
        migration.op, "execute", lambda statement: statements.append(str(statement))
    )

    tables = (
        "event_type_owners",
        "alert_correlation_states",
        "plan_branch_merge_resolutions",
    )
    columns = ("created_at", "updated_at")

    migration.upgrade()

    normalized = [" ".join(statement.split()) for statement in statements]
    assert len(normalized) == 6
    for table in tables:
        for column in columns:
            assert f"ALTER TABLE {table} ALTER COLUMN {column} SET DEFAULT now()" in normalized

    statements.clear()

    migration.downgrade()

    normalized = [" ".join(statement.split()) for statement in statements]
    assert len(normalized) == 6
    for table in tables:
        for column in columns:
            assert f"ALTER TABLE {table} ALTER COLUMN {column} DROP DEFAULT" in normalized


def test_missing_timestamp_server_defaults_migration_is_noop_off_postgresql(
    monkeypatch,
) -> None:
    """The migration must be inert on non-PostgreSQL binds (e.g. the SQLite test DB,
    whose schema is built from ``Base.metadata.create_all``). SQLite cannot
    ``ALTER COLUMN ... SET DEFAULT``, so a dropped dialect guard would break the
    suite; this asserts neither upgrade() nor downgrade() emits any statement."""
    backend_root = Path(__file__).resolve().parents[3]
    migration_path = (
        backend_root
        / "alembic"
        / "versions"
        / "d4e5f6a7b8c9_add_missing_timestamp_server_defaults.py"
    )
    spec = importlib.util.spec_from_file_location(
        "missing_timestamp_server_defaults_migration_noop", migration_path
    )
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)

    statements: list[str] = []
    monkeypatch.setattr(
        migration.op,
        "get_bind",
        lambda: SimpleNamespace(dialect=SimpleNamespace(name="sqlite")),
    )
    monkeypatch.setattr(
        migration.op, "execute", lambda statement: statements.append(str(statement))
    )

    migration.upgrade()
    migration.downgrade()

    assert statements == []


def test_not_null_timestamp_columns_have_server_defaults() -> None:
    import tripl.models  # noqa: F401  (populates Base.metadata with every table)
    from tripl.models.base import Base

    for table in Base.metadata.tables.values():
        for column in table.columns:
            if column.name not in ("created_at", "updated_at"):
                continue
            if column.nullable is not False:
                continue
            assert column.server_default is not None, (
                f"{table.name}.{column.name} is NOT NULL but has no server_default; "
                "migration-built databases will reject INSERTs that omit it"
            )
