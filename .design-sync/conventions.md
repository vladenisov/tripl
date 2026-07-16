# Tripl design system — how to build with it

Components are real compiled React, imported by name from the design-system package (they resolve to `window.Tripl.*`). Everything is presentational and renders correctly under the **default light theme with no provider** — except the cases below.

## Setup & theming
- **Tooltip** must be wrapped in `<TooltipProvider>` (exported alongside `Tooltip`). Nothing else needs a wrapper.
- **Theme classes on an ancestor** (usually `<html>`): `.dark` → dark mode; `.accent-teal|.accent-violet|.accent-lime|.accent-amber|.accent-rose` → accent hue; `.density-compact|.density-cozy|.density-comfy` → row height. `ThemeProvider` (exported) manages these but is optional for static designs. Token VALUES change under these classes, so token-based styling (below) follows the theme automatically.
- **Data-bound composites** — `AppSidebar`, `TopBar`, `BranchSwitcher`, `EventPhotosSection`, `SettingsLayout`, and the monitoring panels (`TopMoversPanel`, `ReleaseRegressionPanel`, `SeasonalityHeatmap`) — need react-query + react-router context and live data. They ship a floor card here; use them only inside an app shell that provides those.

## Styling idiom
Prefer composing components through their **props** — `<Button variant="danger" size="sm">`, `<Chip tone="success" variant="soft">`, `<Badge variant="outline">`, `<MiniStat tone="success">`. For any custom styling or layout glue, use the design tokens as **CSS variables** — all are defined in `:root`, so they always resolve in a rendered design:
- surfaces: `var(--bg)` `var(--bg-elevated)` `var(--bg-sunken)` `var(--surface)` `var(--surface-hover)` `var(--surface-active)`
- text: `var(--fg)` `var(--fg-muted)` `var(--fg-subtle)` `var(--fg-faint)`
- borders: `var(--border)` `var(--border-strong)` `var(--border-subtle)`; radii `var(--radius)` `var(--radius-sm)` `var(--radius-lg)`
- brand: `var(--accent)` `var(--accent-hover)` `var(--accent-soft)` `var(--accent-fg)`
- semantic: `var(--success)` `var(--warning)` `var(--danger)` `var(--info)` — each with a matching `--*-soft` tint
- shadcn aliases: `var(--primary)` `var(--secondary)` `var(--muted)` `var(--destructive)` `var(--card)` `var(--popover)` `var(--ring)`
- fonts: `var(--font-sans)` (Inter), `var(--font-mono)` (JetBrains Mono)

The components are built with **Tailwind v4 utilities mapped to these tokens**; the shipped stylesheet already includes the utility classes the components use — e.g. `bg-primary` `text-primary-foreground` `bg-muted` `text-muted-foreground` `bg-secondary` `border-border` `rounded-md` `rounded-lg` `rounded-xl`, common layout utilities (`flex`, `gap-2`, `items-center`), and `mono` / `tnum` for monospace/tabular numerals. **The stylesheet is static (no per-design Tailwind compile), so a utility class you invent may not exist** — when in doubt, style with the `var(--*)` tokens above (always available), or check `styles.css` for what's present.

## Where the truth lives
- The stylesheet closure `styles.css` (it `@import`s the token layer + `_ds_bundle.css`) — read it before inventing colors, radii, or utility classes.
- Per component: `<Name>.prompt.md` (usage + examples) and `<Name>.d.ts` (`<Name>Props`) — read these before composing a component.

## Idiomatic example
```tsx
import { SCard, Field, TextInput, Toggle, Button } from "<the design-system package>"

<SCard title="Notifications" description="How alerts reach your team">
  <Field label="Webhook URL" hint="POST target for anomaly alerts">
    <TextInput value={url} onChange={setUrl} mono placeholder="https://hooks…" />
  </Field>
  <Field label="Enabled" last>
    <Toggle value={on} onChange={setOn} />
  </Field>
  <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
    <Button variant="outline" size="sm">Cancel</Button>
    <Button size="sm">Save</Button>
  </div>
</SCard>
```
