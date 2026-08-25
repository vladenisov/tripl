---
title: Variables & templates
sidebar_position: 4
---

# Variables & templates

Variables keep reusable values and warehouse paths consistent across the
tracking plan. An event value can contain a placeholder such as
`${checkout_variant}` instead of copying a changing list or source path into
every event.

Use **Plan → Variables** to create and review them. Variables are part of the
active plan branch, so edits follow the same review and merge workflow as
events, fields, and relations.

## What a variable stores

Each variable has:

- a stable, lower-case **name** used by `${name}` placeholders;
- a **type** (`string`, `number`, `boolean`, `date`, `datetime`, `json`, or an
  array type);
- a human-readable **description**;
- **documented values** — the global list the team expects;
- one or more **bindings** — warehouse columns or dotted JSON paths such as
  `variant` or `page_data.extra.variant`;
- observed contexts and samples discovered by scans;
- optional **per-event documented-value overrides**.

The name is for people and templates. A binding is how a scan recognizes the
same concept in raw data. Keeping those separate lets a scan turn a long source
path into a short, readable `${variant}` placeholder without losing the source
mapping.

## Documented, observed, and effective values

tripl deliberately keeps two kinds of value list separate:

- **Documented values** are authored by the team and express the contract.
  Scans never rewrite them.
- **Observed values** and counts are evidence collected from the warehouse.
  Low-cardinality contexts retain the observed list; high-cardinality contexts
  show bounded examples and the total observation count.

The global documented list applies everywhere unless an event has an override.
A per-event override **replaces** the global list for that event; it is not
merged with it. This makes exceptions explicit — for example, most events may
allow `control` and `treatment`, while one legacy event documents a different
set.

To add an override, edit the variable, choose an event under **Per-event
overrides**, enter the complete effective list for that event, and save it.

## Bind a variable to warehouse data

Bindings accept a scalar column name or dotted JSON path:

```text
experiment_variant
page_data.extra.variant
```

When a scan sees a matching source path, it adopts the existing variable rather
than creating a second scan-named variable. New scan-created variables receive a
short display name where possible while retaining the raw source path as their
binding. Search on the Variables page matches that source path and the bindings
as well as the name and description, so a variable shortened to `${aalter}` is
still found by searching for the `property.Aalter` it binds to.

Binding rules:

- start with a letter or underscore;
- use letters, digits, `_`, or `-` in each segment;
- separate JSON path segments with `.`;
- do not add the same binding twice.

## Use placeholders in event values

Event field and meta values can contain `${variable_name}`. The event editor
offers matching variables as you type and previews their description, bindings,
and documented values. Long detail lines stay inside the picker on narrow
editors and are shortened visually rather than expanding the page. Unknown
tokens are highlighted before save; the API also returns advisory `warnings` on
event create/update responses.

Example:

```text
${checkout_variant}
```

Placeholders are a documentation contract, not a runtime expression language:
tripl stores the template and uses it to relate plan values to observed variable
contexts. It does not substitute a single global value into the event.

Hand-authored event field values are protected from scheduled scans. A scan can
still add a missing value, but it will not overwrite a value that a user saved
through the event API or UI.

## Review value drift

After a scan, tripl compares observed values with the effective documented list
for each event. Novel values create a **variable value drift**. Open drift counts
appear on the Variables table, and the same review panel is available on the
affected event's detail page.

Available actions:

- **Accept globally** — add the novel values to the variable's global
  documented list.
- **Accept for this event** — create or update the event override, seeded from
  the current effective list.
- **Snooze** — hide the drift until a chosen time while scans continue to
  refresh its evidence.
- **False positive** — resolve it without changing the documented contract.
- **Reopen** — return a resolved drift to active review.

Resolved drift is collapsed, not hidden: both panels carry a **Show N resolved**
toggle so an acceptance you regret can always be reopened.

A later scan **reopens an accepted drift by itself** as soon as it observes a
value the documented list does not cover. Accepting is what puts the values in
that list, so a value you accepted does not come back and "outside the accepted
set" means genuinely new — the reopened row shows only the new values, and alert
rules subscribed to variable value drift see it again. Snoozed and
false-positive rows are never reopened by a scan.

The documented list is the arbiter, not the row's own history: if you later
**remove an accepted value from the documented list by hand**, the next scan
that sees it opens a drift again. A resolved row cannot keep vouching for a
value the plan no longer documents — and this is also what stops a row that
silently absorbed values under an older build from suppressing them forever.

Alert rules can opt into **Variable value drift**. These candidates behave like
other drift signals: they use the spike direction for rule matching, carry the
variable name and novel-value sample in the alert, and bypass numeric volume
thresholds.

The scope produces nothing until some variable documents values, because drift
is measured against a documented list and there is nothing to compare an
observation with until one exists. A global documented list or a per-event
override will do — either one is enough — but it has to be on the **main**
branch: detection runs against main, so a list documented on a working branch
counts only once that branch merges. A variable
[excluded from scans](#exclude-instead-of-deleting-scan-owned-variables) never
drifts however full its list is, because scans stop observing it. The rule
editor and the monitor detail now say so where the scope is switched on, rather
than leaving a rule to look enabled and stay silent — see
[When a scope is on but nothing feeds it](alerting.md#when-a-scope-is-on-but-nothing-feeds-it).

## When a scan merges events into a group

Scan **event group** rules can fold several existing events into one. The
surviving event keeps the variable data of the events it absorbed: observed
contexts, per-event documented-value overrides, and value-drift triage all move
across rather than disappearing with the merged-away event.

Two details worth knowing:

- a context moves only when the surviving event's value for that field still
  names the variable. A group rule that rewrites a field value to the pattern it
  matched removes the reference, so the context is dropped rather than left
  asserting a reference that is no longer there;
- where both events already carried an entry for the same variable, the
  surviving event's own override or drift decision wins. Observed contexts are
  combined instead: the higher observation count, and the union of the sampled
  values under the usual cap.

## Exclude instead of deleting scan-owned variables

Deleting a variable removes it from the plan, but a later scan can discover the
same bound source path and create it again. Use **Exclude from scans** when the
intent is “this source value must stay out of the plan.”

Exclusion keeps a lightweight tombstone:

- the variable moves to the **Excluded from scans** section;
- scans do not recreate it or accumulate new contexts/drift for it;
- **Restore** makes it active again;
- permanent delete remains available when no scan can reintroduce it.

## Unreferenced scan-created variables are retired automatically

A scan creates a variable for every placeholder it detects. On a JSON column
whose keys are user-typed text — a map rather than a struct — that once meant a
permanent plan row per key. Every catalog run now ends by deleting the
scan-created variables that nothing refers to any more. The sweep works on
`main`, where scans write; the copies on an open working branch are left alone.

A variable is retired only when **all** of the following are true:

- a scan created it and its description is still the scan's own
  (*Auto-detected variable from data source scan*);
- its bindings are still only the source path the scan gave it;
- it documents no values and carries no per-event override;
- it carries no value drift — open or resolved;
- no scan-observed context is recorded against it;
- nothing stored in the project mentions any of its tokens — its display name,
  its scan source path, or any binding — as `${token}`. Both `${token}` sites
  count: an event's **field values** and its **meta values**.

Everything a person touched is out of reach. An edited description, a binding
you added, documented values, an override, a drift you accepted or snoozed, and
an **Exclude from scans** tombstone each keep the row. So does a single
`${token}` left in one event value, even when the variable has no observed
contexts at all.

The run that creates a variable does not normally retire it in the same pass:
that run writes the variable's token into at least one event's field value, so
the reference check keeps it. What retirement removes is the row whose token has
since vanished from every stored value — the leftover of a key that stopped
arriving, or of an event value that was edited to stop using it.

One case does create and retire in the same run: a path that appears only on an
**archived** event. A scan deliberately leaves an archived row's field values
untouched, so the token is never written and nothing live refers to the new
variable.

When a run retires anything it says so in the run's details list: *Retired N
unused variables no event refers to*. To see the set for yourself, the Variables
table's **All / In use / Unused** filter asks the server the same question:
**Unused** lists exactly the rows a run would take, decided by the rule above
rather than by a "used in no events" count.

:::note Clearing a backlog that predates the sweep
An instance owner can run the same pass over a whole branch on demand, from
**Retire unused variables** in the project's [danger
zone](./feature-reference.md#project-general--danger-zone) — **Preview** first,
which commits nothing and reports what it would take, then **Retire**. The route
behind it is `POST /api/v1/projects/{slug}/danger/retire-unused-variables`.
:::

## Bulk changes and branches

Select variables in the table to change their type or description, add
documented values, or delete several at once. Bulk operations apply a uniform
patch to the selection; they do not replace bindings or per-event overrides.

Variables, bindings, documented values, overrides, exclusions, and drift-related
plan changes are branch-aware. The merge dialog warns when a branch would delete
a variable that still exists on `main`, so reviewers can catch a destructive
change before it lands.

## API endpoints

The interactive [API reference](../integrate/api) is authoritative. The main
workflow uses:

```text
GET/POST             /api/v1/projects/{slug}/variables
PATCH/DELETE         /api/v1/projects/{slug}/variables/{variable_id}
POST                 /api/v1/projects/{slug}/variables/bulk-update
POST                 /api/v1/projects/{slug}/variables/bulk-delete
GET                  /api/v1/projects/{slug}/variables/{variable_id}/values
GET                  /api/v1/projects/{slug}/variables/{variable_id}/event-overrides
PUT/DELETE           /api/v1/projects/{slug}/variables/{variable_id}/event-overrides/{event_id}
GET                  /api/v1/projects/{slug}/variables/drifts
POST                 /api/v1/projects/{slug}/variables/drifts/{drift_id}/action
```

Pass the current `branch` query parameter on plan-scoped calls.

## Related pages

- [Concepts](./concepts.md)
- [User guide](./user-guide.md)
- [Feature reference](./feature-reference.md)
- [Alerting rules](./alerting.md)
- [Agent API guide](../integrate/agent-api-guide.md)
