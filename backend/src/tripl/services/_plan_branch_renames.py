from __future__ import annotations

from collections.abc import Mapping

# A natural key is the row's rename scope followed by its name:
# ``("track", "purchase:success")`` for an event, ``("variant",)`` for a
# variable. A rename moves the LAST component and nothing else, so the boundary
# a rename may not cross is exactly ``key[:-1]`` and needs no second argument.
# Moving an event to another event type therefore reads as what it is — not a
# rename — and never pairs.
NaturalKey = tuple[str, ...]


def pair_renames[KeyT: NaturalKey](
    base: Mapping[KeyT, str | None],
    main: Mapping[KeyT, str | None],
    branch: Mapping[KeyT, str | None],
) -> dict[KeyT, KeyT]:
    """Match the rows a merge would DELETE to the rows it would INSERT.

    Each mapping is one side's natural key -> that row's ``source_name``.
    Returns ``old_key -> new_key`` for every pair proven to be a single row the
    branch renamed, so the caller can UPDATE main's row instead of replacing it.

    ``_apply_merge`` upserts by natural key, and for an Event that key contains
    the very name the user edited — Event has no ``display_name``, so its
    machine name IS the displayed one and editing it is routine. A rename
    therefore reads as a removal plus an unrelated addition: main's row is
    deleted, a fresh uuid inserted, and the FK cascade takes
    ``variable_values.event_id``, metrics, photos, alerts and ``event_changes``
    with it. None of those are in ``build_plan_snapshot``, so no diff shows the
    loss and no arm of the merge carries them across.

    ``source_name`` is what survives a rename, and that is the repo's own rule
    rather than a marker invented here: ``update_event`` and ``update_variable``
    write ``name`` and never touch it, ``create_event`` stamps it from the
    generated name because scan dedup keys on it, the Event model declares it
    the stable scan identity, and ``deep_copy_plan_to_branch`` carries it onto
    the branch copy so a branch row still answers to main's identity.

    A pair is made only when that identity is unambiguous: within one scope,
    exactly one would-delete and exactly one would-insert carry the same
    non-empty ``source_name``. Every other shape is left untouched and merges
    the way it does today, as a delete plus an insert:

    * **No source_name.** Nullable by design — "events created outside a scan"
      — so two unrelated rows can both be empty and neither identifies
      anything. Pairing on absence would fuse arbitrary rows.
    * **Two or more candidates on one side.** Only a UniqueConstraint makes
      ``source_name`` singular within a branch, and only Variable carries one;
      events have a plain index, and rows predating either are live. A guess
      here renames the wrong row, which is a worse outcome than the deletion it
      set out to avoid.
    * **An unmatched would-insert or would-delete.** A genuinely added event and
      a genuinely removed one, which must keep merging as an add and a removal.

    The key type is the caller's own, not widened to ``NaturalKey``, so the
    result can be used to re-key the very maps it was derived from.

    Pure by construction — three plain mappings in, one mapping out — because
    the caller is the merge engine, where a wrongly matched id is unrecoverable,
    and every case above therefore deserves a test that needs no database.
    """
    # These two comprehensions are the caller's insert and delete arms restated:
    # main loses a row the base had and the branch no longer lists; the branch
    # gains a row neither main nor the base has. Keeping them here rather than
    # taking the caller's sets is what lets the rules above be tested directly.
    #
    # They also make the two sides disjoint — an old key is on main and a new key
    # is not — so no pair's new key is another pair's old key and a caller can
    # re-key its maps in a single pass without ordering the moves.
    would_delete = [key for key in main if key in base and key not in branch]
    would_insert = [key for key in branch if key not in main and key not in base]

    def by_identity(
        keys: list[KeyT], side: Mapping[KeyT, str | None]
    ) -> dict[tuple[NaturalKey, str], list[KeyT]]:
        grouped: dict[tuple[NaturalKey, str], list[KeyT]] = {}
        for key in keys:
            source_name = side[key]
            if not source_name:
                continue
            grouped.setdefault((key[:-1], source_name), []).append(key)
        return grouped

    removed = by_identity(would_delete, main)
    added = by_identity(would_insert, branch)

    renames: dict[KeyT, KeyT] = {}
    for identity, old_keys in removed.items():
        new_keys = added.get(identity, [])
        if len(old_keys) == 1 and len(new_keys) == 1:
            renames[old_keys[0]] = new_keys[0]
    return renames
