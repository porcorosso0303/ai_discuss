import { resolve, win32 } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { configureWindowsUserDataPath } from '../../../src/main/user-data-path'

describe('Windows user data path', () => {
  it('uses the LocalAppData AI Debates directory before Electron readiness', () => {
    const app = { setPath: vi.fn() }
    const localAppData = 'C:\\Users\\test\\AppData\\Local'

    expect(configureWindowsUserDataPath(app, { LOCALAPPDATA: localAppData }, 'win32')).toBe(true)
    expect(app.setPath).toHaveBeenCalledWith('userData', win32.join(localAppData, 'AI Debates'))
  })

  it.each([
    ['missing', {}],
    ['relative', { LOCALAPPDATA: 'relative/path' }],
    ['NUL-containing', { LOCALAPPDATA: `${resolve('/tmp/local')}\0tail` }]
  ])('keeps the Electron default for a %s LocalAppData value', (_label, env) => {
    const app = { setPath: vi.fn() }

    expect(configureWindowsUserDataPath(app, env, 'win32')).toBe(false)
    expect(app.setPath).not.toHaveBeenCalled()
  })

  it('does not change the user data path outside Windows', () => {
    const app = { setPath: vi.fn() }

    expect(
      configureWindowsUserDataPath(app, { LOCALAPPDATA: resolve('/tmp/local') }, 'linux')
    ).toBe(false)
    expect(app.setPath).not.toHaveBeenCalled()
  })
})
