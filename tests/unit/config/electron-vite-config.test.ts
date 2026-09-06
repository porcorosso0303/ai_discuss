import type { ElectronViteConfigFn } from 'electron-vite'
import type { UserConfig } from 'vite'
import { describe, expect, it } from 'vitest'

import electronViteConfig from '../../../electron.vite.config'

describe('Electron Vite configuration', () => {
  it('uses the single renderer port allowed by the development security policy', async () => {
    expect(electronViteConfig).toBeTypeOf('function')

    const resolveConfig = electronViteConfig as ElectronViteConfigFn
    const config = await resolveConfig({ command: 'serve', mode: 'development' })

    const renderer = config.renderer as UserConfig

    expect(renderer.server).toMatchObject({
      host: 'localhost',
      port: 5173,
      strictPort: true
    })
  })
})
