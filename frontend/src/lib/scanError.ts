/**
 * Scan-error sanitiser (issue H3).
 *
 * Raw backend exceptions must never surface verbatim in the UI: a ClickHouse
 * `HTTPSConnectionPool` read-timeout leaks host/port, a SQLAlchemy
 * `autoflush`/`no_autoflush` hint leaks the ORM internals, and a socket failure
 * leaks `getaddrinfo`/`host=`/`port=`. `friendlyScanError` maps a known raw
 * error to a safe, user-facing `message` and preserves the original string as
 * `technical` so an owner-only "View technical details" expander can show it.
 *
 * Surfaces: dashboard latest-scan card, overview Recent-activity feed, Scans page.
 */

export interface FriendlyScanError {
  /** Safe, user-facing message. Never contains a host, port, library, ORM hint, or function name. */
  message: string
  /** Original raw error, surfaced only behind an owner-only expander. Absent when `raw` is empty. */
  technical?: string
}

const SCAN_FAILED = 'Scan failed.'
const SCAN_FAILED_TIMEOUT = 'Scan failed: the data source did not respond in time.'
const SCAN_FAILED_INTERNAL = 'Scan failed: an internal error occurred while saving results.'
const SCAN_FAILED_CONNECT = 'Scan failed: could not connect to the data source.'

/**
 * Ordered rules — first match wins. Lowercase patterns are matched
 * case-insensitively as substrings. Timeout is checked before connection
 * because a `HTTPSConnectionPool(host=..., port=...): Read timed out` string
 * also contains "Connection"/`host=`/`port=` and must read as a timeout, not a
 * generic connect failure.
 */
const SCAN_ERROR_RULES: ReadonlyArray<{ patterns: readonly string[]; message: string }> = [
  {
    patterns: ['httpsconnectionpool', 'read timed out', 'timeout'],
    message: SCAN_FAILED_TIMEOUT,
  },
  {
    patterns: ['no_autoflush', 'autoflush', 'sqlalchemy'],
    message: SCAN_FAILED_INTERNAL,
  },
  {
    patterns: ['connection', 'refused', 'getaddrinfo', 'host=', 'port='],
    message: SCAN_FAILED_CONNECT,
  },
]

/**
 * Markers that betray a raw, unsanitised exception (host/port, driver, ORM,
 * socket, stack frames). The backend now sanitises scan failures into specific
 * "Scan failed: …" messages; when text reads as one of those AND carries none
 * of these markers, it is safe to show verbatim. This guard makes the
 * pass-through below leak-proof even if some path prefixes raw text with
 * "Scan failed:".
 */
const RAW_INTERNAL_MARKERS = [
  'httpsconnectionpool', 'sqlalchemy', 'autoflush', 'getaddrinfo',
  'host=', 'port=', 'errno', 'traceback', ' object at 0x',
] as const

export function friendlyScanError(raw: string | null | undefined): FriendlyScanError {
  if (!raw || raw.trim() === '') {
    return { message: SCAN_FAILED }
  }

  const trimmed = raw.trim()
  const haystack = trimmed.toLowerCase()

  // The backend already turns scan failures into specific, safe "Scan failed: …"
  // messages. When the text reads as one of those and carries no raw internals,
  // show it verbatim so users keep the specific reason instead of the generic
  // fallback. Pre-sanitisation records and genuinely raw strings fall through to
  // the mapping rules below.
  const hasRawInternals = RAW_INTERNAL_MARKERS.some((marker) => haystack.includes(marker))
  if (!hasRawInternals && haystack.startsWith('scan failed')) {
    return { message: trimmed }
  }

  for (const rule of SCAN_ERROR_RULES) {
    if (rule.patterns.some((pattern) => haystack.includes(pattern))) {
      return { message: rule.message, technical: raw }
    }
  }

  return { message: SCAN_FAILED, technical: raw }
}
