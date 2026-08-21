/**
 * DOM ids for the Settings takeover's landmarks.
 *
 * The takeover mounts outside the app Layout, so it names its own content
 * landmark rather than the shell's `main-content`. Kept in its own module so
 * the shell (SettingsLayout) and the settings palette's focus-restore can both
 * point at it without importing each other in a cycle.
 */

/** The scrolling content column — target of the skip link and of focus restore. */
export const SETTINGS_CONTENT_ID = 'settings-content'
