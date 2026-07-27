/**
 * Shared DOM ids for the app-shell landmarks.
 *
 * Kept in their own module so the skip link (Layout), the settings shell and
 * the command palette's focus-restore can all name the same target without
 * importing each other in a cycle.
 */

/** The scroll container holding the route outlet — target of the skip link. */
export const MAIN_CONTENT_ID = 'main-content'
