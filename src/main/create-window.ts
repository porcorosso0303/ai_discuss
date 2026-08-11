import { join } from 'node:path'

import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'

type BrowserWindowConstructor = new (
  options: BrowserWindowConstructorOptions
) => BrowserWindow

export function createWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  return {
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f4f6fb',
    title: 'AI 模型辩论场',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  }
}

export async function createAppWindow(
  preloadPath: string,
  BrowserWindowClass: BrowserWindowConstructor
): Promise<BrowserWindow> {
  const window = new BrowserWindowClass(createWindowOptions(preloadPath))

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}
