import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const EXPECTED_CSP =
  "default-src 'self'; script-src 'self'; " +
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
  "img-src 'self' data: blob:; font-src 'self' data: https://fonts.gstatic.com; " +
  "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"

function readFrontendFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf8')
}

describe('production CSP contract', () => {
  it('loads executable scripts from the same origin', () => {
    const indexHtml = readFrontendFile('index.html')
    const scriptTags = [...indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]

    expect(scriptTags.length).toBeGreaterThan(0)
    expect(scriptTags.every(([, attributes]) => /\bsrc=/.test(attributes))).toBe(true)
    expect(indexHtml).toContain('<script src="/theme-init.js"></script>')
    expect(indexHtml.indexOf('/theme-init.js')).toBeLessThan(indexHtml.indexOf('/src/main.tsx'))
    expect(readFrontendFile('public/theme-init.js')).not.toHaveLength(0)
  })

  it('keeps the standalone nginx CSP aligned with the frontend resources', () => {
    const indexHtml = readFrontendFile('index.html')
    const nginxConfig = readFrontendFile('nginx.conf')
    const nginxCsp = nginxConfig.match(
      /add_header Content-Security-Policy "([^"]+)" always;/,
    )?.[1]

    expect(indexHtml).toContain('https://fonts.googleapis.com/css2')
    expect(nginxCsp).toBe(EXPECTED_CSP)
  })
})
