import { describe, expect, it } from 'vitest'

import { resolveDesktopRuntime } from '../../../src/main/renderer-runtime'

const rendererPath = '/opt/ai-debates/out/renderer/index.html'

describe('desktop renderer runtime resolution', () => {
  it('ignores ELECTRON_RENDERER_URL unconditionally in packaged builds', () => {
    expect(resolveDesktopRuntime({
      isPackaged: true,
      env: { ELECTRON_RENDERER_URL: 'http://localhost:5173/' },
      rendererPath
    })).toEqual({
      window: { isDevelopment: false, rendererPath },
      ipc: { isDevelopment: false, rendererPath }
    })
  })

  it('gives window loading and IPC the same validated development URL', () => {
    expect(resolveDesktopRuntime({
      isPackaged: false,
      env: { ELECTRON_RENDERER_URL: 'https://[::1]:5173/app?mode=dev' },
      rendererPath
    })).toEqual({
      window: { isDevelopment: true, rendererUrl: 'https://[::1]:5173/app?mode=dev' },
      ipc: { isDevelopment: true, rendererUrl: 'https://[::1]:5173/app?mode=dev' }
    })
  })

  it('falls back both boundaries to the exact file renderer for an invalid development URL', () => {
    expect(resolveDesktopRuntime({
      isPackaged: false,
      env: { ELECTRON_RENDERER_URL: 'http://localhost.evil.test:5173/' },
      rendererPath
    })).toEqual({
      window: { isDevelopment: false, rendererPath },
      ipc: { isDevelopment: false, rendererPath }
    })
  })
})
