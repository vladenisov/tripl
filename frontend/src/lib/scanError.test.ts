import { describe, expect, it } from 'vitest'
import { friendlyScanError } from './scanError'

// Realistic raw exceptions as they arrive from the backend, host/port intact.
const CLICKHOUSE_TIMEOUT =
  "HTTPSConnectionPool(host='clickhouse.internal', port=8443): Read timed out. (read timeout=30)"
const SQLALCHEMY_AUTOFLUSH =
  "InvalidRequestError: This Session's transaction has been rolled back; " +
  'use a session.no_autoflush block to avoid autoflush during this query. ' +
  '(Background on this error at: https://sqlalche.me/e/20/) SQLAlchemy'
const CONNECTION_REFUSED = 'ConnectionRefusedError: [Errno 111] Connection refused'
const GETADDRINFO_FAILURE =
  "socket.gaierror: [Errno -2] getaddrinfo failed for host='db.example.com', port=9000"

/** A user-facing message must leak no host, no port number, no library, no ORM hint. */
function expectSanitised(message: string) {
  expect(message).not.toMatch(/\d/) // no port numbers
  expect(message.toLowerCase()).not.toContain('sqlalchemy')
  expect(message.toLowerCase()).not.toContain('autoflush')
  expect(message.toLowerCase()).not.toContain('host')
  expect(message.toLowerCase()).not.toContain('port')
  expect(message.toLowerCase()).not.toContain('httpsconnectionpool')
  expect(message.toLowerCase()).not.toContain('getaddrinfo')
}

describe('friendlyScanError', () => {
  it('maps a ClickHouse HTTPSConnectionPool read-timeout to the timeout message', () => {
    const result = friendlyScanError(CLICKHOUSE_TIMEOUT)
    expect(result.message).toBe('Scan failed: the data source did not respond in time.')
    expect(result.technical).toBe(CLICKHOUSE_TIMEOUT)
    expectSanitised(result.message)
  })

  it('maps a bare "Read timed out" string to the timeout message', () => {
    expect(friendlyScanError('Read timed out').message).toBe(
      'Scan failed: the data source did not respond in time.',
    )
  })

  it('maps a generic "timeout" string to the timeout message', () => {
    expect(friendlyScanError('upstream request timeout').message).toBe(
      'Scan failed: the data source did not respond in time.',
    )
  })

  it('maps a SQLAlchemy autoflush hint to the internal-error message', () => {
    const result = friendlyScanError(SQLALCHEMY_AUTOFLUSH)
    expect(result.message).toBe('Scan failed: an internal error occurred while saving results.')
    expect(result.technical).toBe(SQLALCHEMY_AUTOFLUSH)
    expectSanitised(result.message)
  })

  it('maps a bare no_autoflush hint to the internal-error message', () => {
    expect(friendlyScanError('with session.no_autoflush:').message).toBe(
      'Scan failed: an internal error occurred while saving results.',
    )
  })

  it('maps a "Connection refused" string to the connect message', () => {
    const result = friendlyScanError(CONNECTION_REFUSED)
    expect(result.message).toBe('Scan failed: could not connect to the data source.')
    expect(result.technical).toBe(CONNECTION_REFUSED)
    expectSanitised(result.message)
  })

  it('maps a getaddrinfo / host= / port= failure to the connect message', () => {
    const result = friendlyScanError(GETADDRINFO_FAILURE)
    expect(result.message).toBe('Scan failed: could not connect to the data source.')
    expect(result.technical).toBe(GETADDRINFO_FAILURE)
    expectSanitised(result.message)
  })

  it('falls back to a bare "Scan failed." for unknown errors but still keeps the technical detail', () => {
    const raw = 'KeyError: tracking_plan_id'
    const result = friendlyScanError(raw)
    expect(result.message).toBe('Scan failed.')
    expect(result.technical).toBe(raw)
  })

  it('passes a backend-sanitised "Scan failed: …" message through verbatim', () => {
    // After the backend sanitises failures (issue H3), error_message reads e.g.
    // "Scan failed: could not connect to the data source." The phrasing does not
    // match the raw-exception patterns, so it must be shown as-is rather than
    // collapsed to a generic "Scan failed.".
    for (const msg of [
      'Scan failed: could not connect to the data source.',
      'Scan failed: the data source did not respond in time.',
      'Scan failed due to an internal error. Please try again or contact support.',
    ]) {
      const result = friendlyScanError(msg)
      expect(result.message).toBe(msg)
      expect(result.technical).toBeUndefined()
    }
  })

  it('does NOT pass through a "Scan failed:" string that still carries raw internals', () => {
    // Defensive: even if a path prefixes raw text, the raw-internals guard forces
    // it back through the mapping rules so host/port never leak.
    const sneaky = "Scan failed: HTTPSConnectionPool(host='db', port=8443): boom"
    const result = friendlyScanError(sneaky)
    expect(result.message).toBe('Scan failed: the data source did not respond in time.')
    expect(result.technical).toBe(sneaky)
    expectSanitised(result.message)
  })

  it('returns no technical detail for nullish input', () => {
    for (const raw of [null, undefined, '', '   ']) {
      const result = friendlyScanError(raw)
      expect(result.message).toBe('Scan failed.')
      expect(result.technical).toBeUndefined()
    }
  })

  it('never leaks a hostname, port, library name or ORM hint in the message', () => {
    for (const raw of [CLICKHOUSE_TIMEOUT, SQLALCHEMY_AUTOFLUSH, CONNECTION_REFUSED, GETADDRINFO_FAILURE]) {
      expectSanitised(friendlyScanError(raw).message)
    }
  })
})
