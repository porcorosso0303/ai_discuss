import { describe, expect, it } from 'vitest'

import { createAppWindow, createWindowOptions } from '../../../src/main/create-window'

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
})
