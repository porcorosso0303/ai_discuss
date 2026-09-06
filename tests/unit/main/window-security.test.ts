import { describe, expect, it, vi } from 'vitest'

import { createAppWindow, createWindowOptions } from '../../../src/main/create-window'

function createWindowHarness() {
  const destroy = vi.fn()
  const isDestroyed = vi.fn(() => false)
  const loadFile = vi.fn().mockResolvedValue(undefined)
  const loadURL = vi.fn().mockResolvedValue(undefined)
  const show = vi.fn()
  let readyToShow: (() => void) | undefined
  let willNavigate:
    | ((event: { preventDefault: () => void }, targetUrl: string) => void)
    | undefined
  let windowOpenHandler: (() => { action: string }) | undefined
  const fakeWindow = {
    destroy,
    isDestroyed,
    loadFile,
    loadURL,
    once: (event: string, callback: () => void) => {
      if (event === 'ready-to-show') {
        readyToShow = callback
      }
    },
    show,
    webContents: {
      on: (
        event: string,
        callback: (event: { preventDefault: () => void }, targetUrl: string) => void
      ) => {
        if (event === 'will-navigate') {
          willNavigate = callback
        }
      },
      setWindowOpenHandler: (handler: () => { action: string }) => {
        windowOpenHandler = handler
      }
    }
  }
  const FakeBrowserWindow = function () {
    return fakeWindow
  }

  return {
    FakeBrowserWindow,
    destroy,
    getReadyToShow: () => readyToShow,
    getWillNavigate: () => willNavigate,
    getWindowOpenHandler: () => windowOpenHandler,
    loadFile,
    loadURL,
    show
  }
}

describe('secure application windows', () => {
  it('isolates the renderer from Electron and Node.js', () => {
    const options = createWindowOptions('/absolute/path/to/preload.js')

    expect(options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
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

  it('shows the hidden window only after ready-to-show', async () => {
    const { FakeBrowserWindow, getReadyToShow, show } = createWindowHarness()

    await createAppWindow('/absolute/path/to/preload.js', FakeBrowserWindow as never)
    expect(show).not.toHaveBeenCalled()

    getReadyToShow()?.()

    expect(show).toHaveBeenCalledOnce()
  })

  it('denies renderer requests to open a new window', async () => {
    const { FakeBrowserWindow, getWindowOpenHandler } = createWindowHarness()

    await createAppWindow('/absolute/path/to/preload.js', FakeBrowserWindow as never)

    expect(getWindowOpenHandler()?.()).toEqual({ action: 'deny' })
  })

  it('prevents renderer navigation to another address', async () => {
    const { FakeBrowserWindow, getWillNavigate } = createWindowHarness()
    const preventDefault = vi.fn()

    await createAppWindow('/absolute/path/to/preload.js', FakeBrowserWindow as never)
    getWillNavigate()?.({ preventDefault }, 'https://attacker.example')

    expect(preventDefault).toHaveBeenCalledOnce()
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
    ['the default HTTP port', 'http://localhost'],
    ['the default HTTPS port', 'https://localhost'],
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
    'https://[::1]:5173'
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

  it.each([
    ['local renderer file', { isDevelopment: false }, 'loadFile' as const],
    [
      'development renderer URL',
      { isDevelopment: true, rendererUrl: 'http://localhost:5173' },
      'loadURL' as const
    ]
  ])('destroys the hidden window when loading the %s fails', async (_case, runtime, loadMethod) => {
    const harness = createWindowHarness()
    const error = new Error('renderer failed to load')
    harness[loadMethod].mockRejectedValueOnce(error)

    await expect(
      createAppWindow(
        '/absolute/path/to/preload.js',
        harness.FakeBrowserWindow as never,
        runtime
      )
    ).rejects.toBe(error)
    expect(harness.destroy).toHaveBeenCalledOnce()
  })
})
