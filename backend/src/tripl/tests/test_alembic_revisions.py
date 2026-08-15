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


def _search_stemming_statements(monkeypatch, direction: str) -> list[str]:
    """Run one direction of ``a7c3e1b9d5f2`` with ``op.execute`` captured.

    The revision is pure ``op.execute``, so its SQL is the whole of it and can be
    asserted without a database — which is the only kind of coverage available
    here, since the suite's schema comes from ``Base.metadata.create_all`` and
    never runs the chain. The executing coverage is the CI round trip
    (empty -> head -> base -> head) plus the relevance harness, which upgrades a
    real PostgreSQL to head before it ranks anything.
    """
    backend_root = Path(__file__).resolve().parents[3]
    migration_path = (
        backend_root / "alembic" / "versions" / "a7c3e1b9d5f2_stem_search_text_configuration.py"
    )
    spec = importlib.util.spec_from_file_location(
        f"search_stemming_migration_{direction}", migration_path
    )
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)

    statements: list[str] = []
    monkeypatch.setattr(
        migration.op, "execute", lambda statement: statements.append(str(statement))
    )
    getattr(migration, direction)()
    return [" ".join(statement.split()) for statement in statements]


def test_search_stemming_migration_routes_each_script_to_its_own_stemmer(
    monkeypatch,
) -> None:
    """tripl-nh5s: ASCII words stem as English, non-ASCII words as Russian.

    This is the shape of the fix, and it is the shape that is easy to get wrong.
    A single chain (``unaccent, english_stem, russian_stem``) looks equivalent
    and is not: a Snowball dictionary never returns NULL, so nothing after the
    first stemmer is ever reached and Cyrillic would silently go unstemmed. The
    split therefore has to live in the token-type mapping, and that is what is
    asserted here — together with ``unaccent`` staying FIRST in both chains,
    because it is a filtering dictionary that must hand the token on to the
    stemmer rather than be shadowed by it.
    """
    statements = _search_stemming_statements(monkeypatch, "upgrade")
    joined = "\n".join(statements)

    assert "CREATE TEXT SEARCH DICTIONARY tripl_english_stem" in joined
    assert "CREATE TEXT SEARCH DICTIONARY tripl_russian_stem" in joined
    # No stopword list on either: event names in this catalog are built out of
    # English function words (sign_in / sign_out, opt_in / opt_out), and the
    # parser splits them on the underscore, so a stopword list would index those
    # two names to the identical single lexeme.
    assert "StopWords" not in joined

    ascii_mapping = next(
        statement for statement in statements if "ALTER MAPPING FOR asciiword" in statement
    )
    assert "WITH unaccent, tripl_english_stem" in ascii_mapping
    cyrillic_mapping = next(
        statement for statement in statements if "ALTER MAPPING FOR word," in statement
    )
    assert "WITH unaccent, tripl_russian_stem" in cyrillic_mapping


def test_search_stemming_migration_rebuilds_stored_vectors_in_both_directions(
    monkeypatch,
) -> None:
    """tripl-nh5s: a configuration change does not touch an existing tsvector.

    Queries are parsed with the NEW configuration the instant the mapping
    changes, while every stored ``text_vector`` still holds lexemes produced by
    the old one — a state strictly worse than the bug, because ``q='purchase'``
    would stem to ``purchas`` and stop matching the stored ``purchase``. The
    rebuild has to happen in the same transaction as the mapping change, in BOTH
    directions, which is what this pins.
    """
    for direction in ("upgrade", "downgrade"):
        statements = _search_stemming_statements(monkeypatch, direction)
        rebuild = [statement for statement in statements if statement.startswith("UPDATE")]
        assert len(rebuild) == 1, f"{direction}() must rebuild the vectors exactly once"
        # The stem-only expression this revision shipped, pinned as HISTORY. It
        # was identical to search_service._refresh_text_vectors on the day it
        # ran; tripl-uojz has since added a surface leg to the live expression,
        # so the two are deliberately no longer the same string and this
        # assertion must NOT be "corrected" to follow the service. What the live
        # expression has to agree with is b6d1f0a3c7e2 — see
        # test_surface_form_migration_matches_the_service_expression.
        assert (
            "SET text_vector = to_tsvector( 'tripl_search', "
            "concat_ws(' ', title, subtitle, body, keywords) )" in rebuild[0]
        )


def test_search_stemming_migration_downgrade_restores_the_simple_mapping(
    monkeypatch,
) -> None:
    """The CI round trip runs empty -> head -> base -> head (tripl-nh5s).

    So ``downgrade()`` has to put the configuration back exactly as
    e8f9a0b1c2d3 left it — all six word token types on ``unaccent, simple`` —
    and it has to DROP both dictionaries. ``CREATE TEXT SEARCH DICTIONARY`` has
    no ``IF NOT EXISTS``: a dictionary left behind at base would survive into the
    re-upgrade and fail it, and no leftover-object check in CI looks at the
    text-search catalogs.
    """
    statements = _search_stemming_statements(monkeypatch, "downgrade")

    mapping = next(statement for statement in statements if "ALTER MAPPING" in statement)
    for token_type in (
        "asciiword",
        "asciihword",
        "hword_asciipart",
        "word",
        "hword",
        "hword_part",
    ):
        assert token_type in mapping
    assert "WITH unaccent, simple" in mapping

    drops = [statement for statement in statements if statement.startswith("DROP")]
    assert drops == [
        "DROP TEXT SEARCH DICTIONARY IF EXISTS tripl_russian_stem",
        "DROP TEXT SEARCH DICTIONARY IF EXISTS tripl_english_stem",
    ]
    # A dictionary still referenced by a configuration cannot be dropped, so the
    # mapping must be restored first.
    assert statements.index(mapping) < statements.index(drops[0])


SURFACE_FORM_MIGRATION = "b6d1f0a3c7e2_index_surface_forms_beside_stems.py"


def _load_migration(module_name: str, filename: str):
    backend_root = Path(__file__).resolve().parents[3]
    migration_path = backend_root / "alembic" / "versions" / filename
    spec = importlib.util.spec_from_file_location(module_name, migration_path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def _surface_form_statements(monkeypatch, direction: str) -> list[str]:
    """Run one direction of ``b6d1f0a3c7e2`` with ``op.execute`` captured.

    Same shape as :func:`_search_stemming_statements` and for the same reason:
    the revision is pure ``op.execute``, the suite's schema comes from
    ``Base.metadata.create_all`` and never runs the chain, so asserting the SQL
    is the only coverage available without a database.
    """
    migration = _load_migration(f"surface_form_migration_{direction}", SURFACE_FORM_MIGRATION)
    statements: list[str] = []
    monkeypatch.setattr(
        migration.op, "execute", lambda statement: statements.append(str(statement))
    )
    getattr(migration, direction)()
    return [" ".join(statement.split()) for statement in statements]


def test_surface_form_migration_matches_the_service_expression() -> None:
    """tripl-uojz: the migration and the service must build the SAME tsvector.

    The migration rebuilds every stored vector once; ``_refresh_text_vectors``
    writes every vector produced afterwards. If the two expressions drift apart,
    nothing raises: half the table is indexed one way, half the other, and the
    only symptom is that some documents stop being reachable by some forms of
    some words — the very bug being fixed, reintroduced silently and partially.

    a7c3e1b9d5f2 guarded that with a copied string literal and a docstring saying
    the two were byte-identical. That is a convention, and the assertion above it
    could only ever check the literal it was written against. This compares the
    two constants themselves, so editing either one alone turns this red.

    The duplication is kept on purpose: a migration must not import application
    code, or it stops meaning what it meant on the day it ran.
    """
    from tripl.services.search_service import TEXT_VECTOR_EXPRESSION

    migration = _load_migration("surface_form_migration_expression", SURFACE_FORM_MIGRATION)

    def normalized(sql: str) -> str:
        return " ".join(sql.split())

    assert normalized(migration._TEXT_VECTOR_EXPRESSION) == normalized(TEXT_VECTOR_EXPRESSION)
    # And the live expression really is the two-leg one, so a revert of both
    # halves at once cannot pass this by making them identically stem-only.
    assert "tripl_search_surface" in normalized(TEXT_VECTOR_EXPRESSION)
    assert "'tripl_search'," in normalized(TEXT_VECTOR_EXPRESSION)


def test_surface_form_migration_creates_the_unstemmed_configuration(monkeypatch) -> None:
    """``tripl_search_surface`` must be the PRE-stemming configuration, exactly.

    Two properties are load-bearing and easy to lose:

    * ``unaccent`` stays in the chain. The stem leg unaccents before stemming, so
      ``зачёты`` stems via ``зачеты``; a surface leg without ``unaccent`` would
      index ``зачёт`` and the ``surface(A) == stem(B)`` identity the whole fix
      rests on would fail for every word containing ``ё``.
    * All six word token types are mapped. Anything left on the bare ``simple``
      dictionary is fine (that is what ``tripl_search`` does too), but a word type
      MISSING from this list would be accent-sensitive on one leg and not the
      other.
    """
    statements = _surface_form_statements(monkeypatch, "upgrade")
    joined = "\n".join(statements)

    assert "CREATE TEXT SEARCH CONFIGURATION tripl_search_surface (COPY = simple)" in joined
    # No stemmer of any kind on this leg -- that is the entire point of it.
    assert "tripl_english_stem" not in joined
    assert "tripl_russian_stem" not in joined

    mapping = next(statement for statement in statements if "ALTER MAPPING" in statement)
    for token_type in (
        "asciiword",
        "asciihword",
        "hword_asciipart",
        "word",
        "hword",
        "hword_part",
    ):
        assert token_type in mapping
    assert "WITH unaccent, simple" in mapping

    rebuild = [statement for statement in statements if statement.startswith("UPDATE")]
    assert len(rebuild) == 1, "upgrade() must rebuild the vectors exactly once"
    assert "tripl_search_surface" in rebuild[0]
    # The configuration has to exist before the UPDATE that references it.
    assert statements.index(mapping) < statements.index(rebuild[0])


def test_surface_form_migration_downgrade_returns_to_the_stem_only_state(monkeypatch) -> None:
    """CI runs empty -> head -> base -> head (tripl-uojz).

    So ``downgrade()`` has to leave exactly what ``upgrade()`` found: vectors
    rebuilt with a7c3e1b9d5f2's stem-only expression, and the configuration
    dropped. A configuration surviving at base would fail the re-upgrade —
    ``CREATE TEXT SEARCH CONFIGURATION`` has no ``IF NOT EXISTS`` — and no
    leftover-object check in CI looks at the text-search catalogs.
    """
    statements = _surface_form_statements(monkeypatch, "downgrade")

    rebuild = [statement for statement in statements if statement.startswith("UPDATE")]
    assert len(rebuild) == 1, "downgrade() must rebuild the vectors exactly once"
    assert (
        "SET text_vector = to_tsvector( 'tripl_search', "
        "concat_ws(' ', title, subtitle, body, keywords) )" in rebuild[0]
    )
    assert "tripl_search_surface" not in rebuild[0]

    drops = [statement for statement in statements if statement.startswith("DROP")]
    assert drops == ["DROP TEXT SEARCH CONFIGURATION IF EXISTS tripl_search_surface"]


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
