import { describe, expect, it, vi } from 'vitest'

import { createAppWindow, createWindowOptions } from '../../../src/main/create-window'

function createWindowHarness() {
  const loadFile = vi.fn().mockResolvedValue(undefined)
  const loadURL = vi.fn().mockResolvedValue(undefined)
  const fakeWindow = {
    loadFile,
    loadURL,
    once: () => undefined,
    show: () => undefined,
    webContents: {
      on: () => undefined,
      setWindowOpenHandler: () => undefined
    }
  }
  const FakeBrowserWindow = function () {
    return fakeWindow
  }

  return { FakeBrowserWindow, loadFile, loadURL }
}

describe('secure application windows', () => {
  it('isolates the renderer from Electron and Node.js', () => {
    const options = createWindowOptions('/absolute/path/to/preload.js')

    expect(options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    })
  })

  it('can create a window through an injected constructor without starting Electron', async () => {
    let receivedOptions: ReturnType<typeof createWindowOptions> | undefined
    const fakeWindow = {
      loadFile: async () => undefined,
      loadURL: async () => undefined,
      once: () => undefined,
      show: () => undefined,
      webContents: {
        on: () => undefined,
        setWindowOpenHandler: () => undefined
      }
    }
    const FakeBrowserWindow = function (options: ReturnType<typeof createWindowOptions>) {
      receivedOptions = options
      return fakeWindow
    }

    const window = await createAppWindow(
      '/absolute/path/to/preload.js',
      FakeBrowserWindow as never
    )

    expect(window).toBe(fakeWindow)
    expect(receivedOptions?.webPreferences?.preload).toBe('/absolute/path/to/preload.js')
  })

  it('ignores ELECTRON_RENDERER_URL outside development mode', async () => {
    const { FakeBrowserWindow, loadFile, loadURL } = createWindowHarness()
    vi.stubEnv('ELECTRON_RENDERER_URL', 'https://attacker.example/app')

    try {
      await createAppWindow(
        '/absolute/path/to/preload.js',
        FakeBrowserWindow as never,
        {
          isDevelopment: false,
          rendererUrl: process.env.ELECTRON_RENDERER_URL
        }
      )
    } finally {
      vi.unstubAllEnvs()
    }

    expect(loadURL).not.toHaveBeenCalled()
    expect(loadFile).toHaveBeenCalledOnce()
  })

  it.each([
    ['an external host', 'https://attacker.example:5173'],
    ['a loopback-looking subdomain', 'http://localhost.attacker.example:5173'],
    ['embedded credentials', 'http://user:password@localhost:5173'],
    ['a non-HTTP protocol', 'ws://localhost:5173'],
    ['a non-loopback address', 'http://127.0.0.2:5173'],
    ['an unapproved port', 'http://localhost:5174'],
    ['a malformed URL', 'not a URL']
  ])('rejects %s as a development renderer URL', async (_case, rendererUrl) => {
    const { FakeBrowserWindow, loadFile, loadURL } = createWindowHarness()

    await createAppWindow('/absolute/path/to/preload.js', FakeBrowserWindow as never, {
      isDevelopment: true,
      rendererUrl
    })

    expect(loadURL).not.toHaveBeenCalled()
    expect(loadFile).toHaveBeenCalledOnce()
  })

  it.each([
    'http://localhost:5173',
    'https://localhost:5173',
    'http://127.0.0.1:5173',
    'https://[::1]:5173',
    'http://localhost',
    'https://localhost'
  ])('allows the trusted development renderer URL %s', async (rendererUrl) => {
    const { FakeBrowserWindow, loadFile, loadURL } = createWindowHarness()

    await createAppWindow('/absolute/path/to/preload.js', FakeBrowserWindow as never, {
      isDevelopment: true,
      rendererUrl
    })

    expect(loadURL).toHaveBeenCalledOnce()
    expect(loadURL).toHaveBeenCalledWith(rendererUrl)
    expect(loadFile).not.toHaveBeenCalled()
  })
})
