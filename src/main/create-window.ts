import { join } from 'node:path'

import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'

type BrowserWindowConstructor = new (
  options: BrowserWindowConstructorOptions
) => BrowserWindow

export interface WindowRuntime {
  isDevelopment: boolean
  rendererUrl?: string
}

const trustedDevelopmentHosts = new Set(['localhost', '127.0.0.1', '[::1]'])
const trustedDevelopmentProtocols = new Set(['http:', 'https:'])
const trustedDevelopmentPorts = new Set(['5173'])

function getTrustedDevelopmentUrl(rendererUrl: string | undefined): string | undefined {
  if (!rendererUrl) {
    return undefined
  }

  try {
    const url = new URL(rendererUrl)
    const isTrusted =
      trustedDevelopmentProtocols.has(url.protocol) &&
      trustedDevelopmentHosts.has(url.hostname) &&
      trustedDevelopmentPorts.has(url.port) &&
      url.username === '' &&
      url.password === ''

    return isTrusted ? rendererUrl : undefined
  } catch {
    return undefined
  }
}

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
  BrowserWindowClass: BrowserWindowConstructor,
  runtime: WindowRuntime = { isDevelopment: false }
): Promise<BrowserWindow> {
  const window = new BrowserWindowClass(createWindowOptions(preloadPath))
  const developmentUrl = runtime.isDevelopment
    ? getTrustedDevelopmentUrl(runtime.rendererUrl)
    : undefined

  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  try {
    if (developmentUrl) {
      await window.loadURL(developmentUrl)
    } else {
      await window.loadFile(join(__dirname, '../renderer/index.html'))
    }
  } catch (error) {
    if (!window.isDestroyed()) {
      window.destroy()
    }
    throw error
  }

  return window
}
