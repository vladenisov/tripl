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
binding.

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

## Exclude instead of deleting scan-owned variables

Deleting a variable removes it from the plan, but a later scan can discover the
same bound source path and create it again. Use **Exclude from scans** when the
intent is “this source value must stay out of the plan.”

Exclusion keeps a lightweight tombstone:

- the variable moves to the **Excluded from scans** section;
- scans do not recreate it or accumulate new contexts/drift for it;
- **Restore** makes it active again;
- permanent delete remains available when no scan can reintroduce it.

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
