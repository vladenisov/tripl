/**
 * A random v4 UUID that also works outside a secure context.
 *
 * `crypto.randomUUID` only exists on HTTPS and localhost. A self-hosted
 * instance served over plain `http://10.0.0.5:5173` is supported by the
 * backend, and there the bare call throws a TypeError — before `fetch`, so
 * every API request (`/auth/me` included) failed. `crypto.getRandomValues` is
 * available in insecure contexts too, so the fallback builds the same RFC 4122
 * layout from it.
 */
export function uid(): string {
  const c = globalThis.crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()

  const bytes = new Uint8Array(16)
  if (typeof c?.getRandomValues === 'function') {
    c.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
