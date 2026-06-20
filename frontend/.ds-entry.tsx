// design-sync barrel — the bundle entry for the claude.ai/design import.
// Curated re-export of the Tripl design-system surface. Committed (durable
// build input); regenerated/edited only when the synced component set changes.
// `export *` is used per file except where names collide (see settings/kit).

/* ── UI primitives (shadcn-style) ─────────────────────────────────────────── */
export * from "./src/components/ui/button";
export * from "./src/components/ui/badge";
export * from "./src/components/ui/card";
export * from "./src/components/ui/input";
export * from "./src/components/ui/textarea";
export * from "./src/components/ui/label";
export * from "./src/components/ui/checkbox";
export * from "./src/components/ui/switch";
export * from "./src/components/ui/select";
export * from "./src/components/ui/tabs";
export * from "./src/components/ui/dialog";
export * from "./src/components/ui/alert-dialog";
export * from "./src/components/ui/dropdown-menu";
export * from "./src/components/ui/popover";
export * from "./src/components/ui/tooltip";
export * from "./src/components/ui/sheet";
export * from "./src/components/ui/scroll-area";
export * from "./src/components/ui/separator";
export * from "./src/components/ui/collapsible";
export * from "./src/components/ui/table";
export * from "./src/components/ui/skeleton";
export * from "./src/components/ui/sonner";

/* ── Charts ───────────────────────────────────────────────────────────────── */
export * from "./src/components/ui/chart";

/* ── Custom primitives ────────────────────────────────────────────────────── */
export * from "./src/components/primitives/chip";
export * from "./src/components/primitives/dot";
export * from "./src/components/primitives/kbd";
export * from "./src/components/primitives/mini-stat";
export * from "./src/components/primitives/sensitivity-chip";
export * from "./src/components/primitives/sparkline";

/* ── Settings kit ─────────────────────────────────────────────────────────── */
// Omit kit's `Select` — it collides with ui/select's `Select` and `export *`
// would drop both to undefined. ui's Select wins; kit Select is excluded.
export {
  Field,
  InfoRow,
  PageHead,
  Panel,
  RadioCards,
  SCard,
  SHeader,
  TextArea,
  TextInput,
  Toggle,
  ToggleRow,
} from "./src/components/settings/kit";
export * from "./src/components/settings/SettingsLayout";

/* ── App composites ───────────────────────────────────────────────────────── */
export * from "./src/components/app-sidebar";
export * from "./src/components/top-bar";
export * from "./src/components/branch-switcher";
export * from "./src/components/theme-toggle";
export * from "./src/components/activity-panel";
export * from "./src/components/empty-state";
export * from "./src/components/error-state";
export { default as ConfirmDialog } from "./src/components/ConfirmDialog";
export { default as EventPhotosSection } from "./src/components/event-photos-section";
export * from "./src/components/variable-value-contexts";

/* ── Monitoring panels ────────────────────────────────────────────────────── */
export * from "./src/components/monitoring/top-movers-panel";
export * from "./src/components/monitoring/release-regression-panel";
export * from "./src/components/monitoring/seasonality-heatmap";

/* ── Providers (not carded; available as preview wrappers) ────────────────── */
export { ThemeProvider } from "./src/components/theme-provider";
