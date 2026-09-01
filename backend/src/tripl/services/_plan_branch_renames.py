from __future__ import annotations

from collections.abc import Mapping

# A natural key is the row's rename scope followed by its name:
# ``("track", "purchase:success")`` for an event, ``("variant",)`` for a
# variable. A rename moves the LAST component and nothing else, so the boundary
# a rename may not cross is exactly ``key[:-1]`` and needs no second argument.
# Moving an event to another event type therefore reads as what it is — not a
# rename — and never pairs.
NaturalKey = tuple[str, ...]


def _sole_key_by_identity[KeyT: NaturalKey](
    side: Mapping[KeyT, str | None],
) -> dict[tuple[NaturalKey, str], KeyT]:
    """Each ``(scope, source_name)`` this side names exactly once, and its key.

    An identity carried by two rows is dropped rather than guessed at: only a
    UniqueConstraint makes ``source_name`` singular within a branch, and only
    Variable carries one (``uq_variable_project_source_name``); events have a
    plain index and rows predating either are live.
    """
    keys_by_identity: dict[tuple[NaturalKey, str], list[KeyT]] = {}
    for key, source_name in side.items():
        # Nullable by design — "rows created outside a scan" — so two unrelated
        # rows can both be empty and neither identifies anything. Pairing on
        # absence would fuse arbitrary rows.
        if not source_name:
            continue
        keys_by_identity.setdefault((key[:-1], source_name), []).append(key)
    return {identity: keys[0] for identity, keys in keys_by_identity.items() if len(keys) == 1}


def pair_renames[KeyT: NaturalKey](
    base: Mapping[KeyT, str | None],
    main: Mapping[KeyT, str | None],
    branch: Mapping[KeyT, str | None],
) -> dict[KeyT, KeyT]:
    """Match main's rows to the branch rows they were renamed into.

    Each mapping is one side's natural key -> that row's ``source_name``.
    Returns ``old_key -> new_key`` for every pair proven to be a single row the
    branch renamed, so the caller can UPDATE main's row instead of replacing it.

    ``_apply_merge`` upserts by natural key, and for an Event that key contains
    the very name the user edited — Event has no ``display_name``, so its
    machine name IS the displayed one and editing it is routine. Left unpaired,
    a rename reads as a removal plus an unrelated addition: main's row is
    deleted, a fresh uuid inserted, the FK cascade takes
    ``variable_values.event_id``, their drift rows and ``event_changes`` with
    it, and the ``event_metrics`` series is left holding a NULL ``event_id``.
    None of those are in ``build_plan_snapshot``, so no diff shows the loss and
    no arm of the merge carries them across. Photos cascade as well but do not
    belong on that list — they are snapshotted and the merge has an arm that
    re-creates them — and alerting holds no FK to an event at all; what makes
    the losses above worth a rename is that nothing sees them go.

    ``source_name`` is what survives a rename, and that is the repo's own rule
    rather than a marker invented here: ``update_event`` and ``update_variable``
    write ``name`` and never touch it, ``create_event`` stamps it from the
    generated name because scan dedup keys on it, the Event model declares it
    the stable scan identity, and ``deep_copy_plan_to_branch`` carries it onto
    the branch copy so a branch row still answers to main's identity.

    So the pairing reads the identity directly on both sides and never the name
    key sets. That is the whole of tripl-htcz: derived from the key sets, a
    rename was only visible when its name VANISHED from the branch, and in a
    cycle no name vanishes. A plain swap — A renamed to B while B is renamed to
    A, reachable through a temporary name — left both sets empty and paired
    nothing, and a longer rotation put mismatched rows in them. The upsert then
    matched each branch row to the main row wearing its new name and wrote that
    row's ``source_name`` onto it, which for a Variable is a non-deferrable
    ``UNIQUE (project_id, branch_id, source_name)`` violated inside one flush.

    A pair is still made only when the identity is unambiguous, and the shapes
    that must keep merging as a delete plus an insert still do:

    * **No source_name**, or **two or more candidates on one side** — see
      ``_sole_key_by_identity``, which drops both.
    * **An identity only one side carries.** A genuinely added row and a
      genuinely removed one, which must keep merging as an add and a removal.
    * **A row main never had at the base.** A rename moves a row that existed
      when the branch was cut; anything else is main's own edit racing the
      branch's, which conflict detection judges rather than this.
    * **A move onto a name a STAYING main row still holds.** The branch renamed
      A to B while main independently grew its own B: honouring the rename would
      put two rows on one name. Dropping one such move can strand another that
      was only legal because its destination was being vacated, so the check
      repeats until it stops finding any.

    The key type is the caller's own, not widened to ``NaturalKey``, so the
    result can be used to re-key the very maps it was derived from — with
    ``rekey_in_place``, because the result may now be a permutation.

    Pure by construction — three plain mappings in, one mapping out — because
    the caller is the merge engine, where a wrongly matched id is unrecoverable,
    and every case above therefore deserves a test that needs no database.
    """
    main_by_identity = _sole_key_by_identity(main)
    branch_by_identity = _sole_key_by_identity(branch)

    moves: dict[KeyT, KeyT] = {}
    for identity, old_key in main_by_identity.items():
        new_key = branch_by_identity.get(identity)
        if new_key is None or new_key == old_key or old_key not in base:
            continue
        moves[old_key] = new_key

    # A destination is free either because main has nothing there or because the
    # row that is there is itself moving away. Removing a move makes its source a
    # staying row, which can block a move that was previously fine, so this runs
    # to a fixed point rather than once.
    while blocked := [old for old, new in moves.items() if new in main and new not in moves]:
        for old in blocked:
            del moves[old]
    return moves


def rekey_in_place[KeyT, ValueT](mapping: dict[KeyT, ValueT], renames: Mapping[KeyT, KeyT]) -> None:
    """Move every ``old_key -> new_key`` of ``renames`` at once.

    ``pair_renames`` can return a permutation — a two-row swap, or a longer
    rotation — so one pair's new key is another pair's old key. Re-keying a pair
    at a time would file the first row under the second pair's OLD key and then
    read it straight back as the second row, quietly fusing two identities
    (tripl-htcz). Lifting every moving entry out before putting any back cannot.

    ``mapping`` must hold every old key. ``pair_renames`` only proposes a move
    for a key that is on main and in the base, which is exactly what the merge
    engine passes here — a ``KeyError`` means that invariant broke, and is a
    better answer than a half-applied permutation.
    """
    lifted = {old: mapping.pop(old) for old in renames}
    for old, new in renames.items():
        mapping[new] = lifted[old]
