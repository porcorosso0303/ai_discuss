import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import { transformRendererCsp } from '../../../src/renderer/csp'

const rendererHtml = readFileSync(resolve('src/renderer/index.html'), 'utf8')

describe('renderer CSP transformation', () => {
  it('removes the development websocket origin from production HTML', () => {
    const transformed = transformRendererCsp(rendererHtml, false)

    expect(transformed).not.toContain('ws://')
    expect(transformed).not.toContain('__RENDERER_HMR_ORIGIN__')
    expect(transformed).toContain("connect-src 'self';")
  })

  it('allows only the configured HMR origin in development HTML', () => {
    const transformed = transformRendererCsp(rendererHtml, true)

    expect(transformed).toContain("connect-src 'self' ws://localhost:5173;")
    expect(transformed).not.toContain('ws://localhost:*')
    expect(transformed).not.toContain('__RENDERER_HMR_ORIGIN__')
  })
})
