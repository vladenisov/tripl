import ast
import importlib.util
from pathlib import Path
from types import SimpleNamespace

import sqlalchemy as sa
from alembic.config import Config
from alembic.script import ScriptDirectory

# The revision that finished converting every legacy VARCHAR status/kind column
# to a native PostgreSQL enum. Migrations at or before it may legitimately
# declare an enum column as a String — the conversion is what fixes them — so the
# parity check below starts immediately after it.
_ENUM_CONVERSION_CUTOFF = "f5a6b7c8d9e0"

# Type constructors that produce a VARCHAR/TEXT column. A native-enum column
# declared with one of these is the exact drift this check exists to catch.
_STRING_TYPE_NAMES = frozenset({"String", "VARCHAR", "Text", "TEXT", "Unicode", "CHAR"})


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


def _string_literal(node: ast.expr) -> str | None:
    return node.value if isinstance(node, ast.Constant) and isinstance(node.value, str) else None


def _declares_a_string_column(type_node: ast.expr) -> bool:
    """True when the column's type expression is literally ``sa.String(...)`` & co.

    Deliberately narrow. A migration is free to build its type through a helper
    (``_scan_interval()``, a module-level ``postgresql.ENUM`` constant); those are
    opaque here and are treated as fine. The one shape this rejects is a plain
    VARCHAR/TEXT constructor, which is the only way this drift has ever occurred.
    """
    if not isinstance(type_node, ast.Call):
        return False
    func = type_node.func
    if isinstance(func, ast.Attribute):
        return func.attr in _STRING_TYPE_NAMES
    return isinstance(func, ast.Name) and func.id in _STRING_TYPE_NAMES


def _declared_columns(tree: ast.Module) -> list[tuple[str, str, ast.expr]]:
    """``(table, column, type expression)`` for every column a migration creates."""
    declared: list[tuple[str, str, ast.expr]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        if node.func.attr == "create_table" and node.args:
            table, column_args = _string_literal(node.args[0]), node.args[1:]
        elif node.func.attr == "add_column" and len(node.args) >= 2:
            table, column_args = _string_literal(node.args[0]), [node.args[1]]
        else:
            continue
        if table is None:
            continue
        for arg in column_args:
            if (
                isinstance(arg, ast.Call)
                and isinstance(arg.func, ast.Attribute)
                and arg.func.attr == "Column"
                and len(arg.args) >= 2
            ):
                column = _string_literal(arg.args[0])
                if column is not None:
                    declared.append((table, column, arg.args[1]))
    return declared


def test_native_enum_model_columns_are_not_created_as_varchar() -> None:
    """A column the model maps to a native enum must be created as that enum.

    ``tests/conftest.py`` builds its schema from ``Base.metadata.create_all``, so
    a migration that declares ``sa.String`` where the model declares
    ``db_enum(...)`` is invisible to every other test in the suite and diverges
    only in production: the column loses its domain constraint, the next
    ``--autogenerate`` emits a spurious ALTER into an unrelated migration, and
    asyncpg renders ``$1::<enum>`` binds against a varchar column. Caught once on
    ``scan_dry_run_jobs.status``; this is the check that would have caught it.
    """
    import tripl.models  # noqa: F401  (populates Base.metadata with every table)
    from tripl.models.base import Base

    native_enums = {
        (table.name, column.name): column.type.name
        for table in Base.metadata.tables.values()
        for column in table.columns
        if isinstance(column.type, sa.Enum) and column.type.native_enum
    }
    assert native_enums, "no native enum columns found — the check would be vacuous"

    backend_root = Path(__file__).resolve().parents[3]
    config = Config(str(backend_root / "alembic.ini"))
    config.set_main_option("script_location", str(backend_root / "alembic"))
    script = ScriptDirectory.from_config(config)

    offenders: list[str] = []
    for revision in script.iterate_revisions("heads", _ENUM_CONVERSION_CUTOFF):
        if revision.revision == _ENUM_CONVERSION_CUTOFF:
            continue
        path = Path(revision.path)
        tree = ast.parse(path.read_text(), filename=str(path))
        for table, column, type_node in _declared_columns(tree):
            enum_name = native_enums.get((table, column))
            if enum_name is not None and _declares_a_string_column(type_node):
                offenders.append(
                    f"{path.name}: {table}.{column} is created as "
                    f"{ast.unparse(type_node)} but the model maps it to the "
                    f"{enum_name!r} native enum — use "
                    f'postgresql.ENUM(name="{enum_name}", create_type=False)'
                )

    assert offenders == [], "migration/model type drift:\n" + "\n".join(offenders)


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
